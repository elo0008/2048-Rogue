// scripts/lib/inmemory_db.js
// Shared in-memory database engine simulating PostgreSQL RLS, submit-run RPCs, and set-name RPCs

import {
  computeDailyBest,
  computeMyDailyRank,
  computeWeeklyBest,
  computeMyWeeklyRank,
  computeAlltimeBest,
  computeMyAlltimeRank,
} from './ranking.js';

export class SecurityDatabaseEngine {
  constructor() {
    this.devices = new Map();
    this.dailyRuns = [];
    this.rateLimits = new Map();
    this.challenges = new Map();
  }

  // Adapter methods used by submit-run Edge Function (service_role context)
  async isDeviceRegistered(deviceId) {
    return this.devices.has(deviceId);
  }

  async registerDevice(deviceId, displayName) {
    this.devices.set(deviceId, {
      deviceId,
      displayName,
      generatedName: displayName,
      nameHidden: false,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  }

  async updateDeviceSeen(deviceId) {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeenAt = new Date().toISOString();
  }

  async isDuplicateEvent(deviceId, eventsHash) {
    return this.dailyRuns.some(r => r.deviceId === deviceId && r.eventsHash === eventsHash);
  }

  // Single atomic statement (UPSERT with increment) simulation
  async consumeRateLimit(key, limit) {
    const count = (this.rateLimits.get(key) || 0) + 1;
    this.rateLimits.set(key, count);
    return { allowed: count <= limit, current: count };
  }

  async recordAcceptedRun(submission) {
    const id = this.dailyRuns.length + 1;
    this.dailyRuns.push({
      id,
      ...submission,
      receivedAt: submission.receivedAt || new Date().toISOString(),
    });
    return { id };
  }

  async precheckSubmission(ip, deviceId, hourKey, dayKey, ipReqLimit, ipNewDevLimit) {
    const ipReqKey = `ip_req:${ip}:${hourKey}`;
    const ipCheck = await this.consumeRateLimit(ipReqKey, ipReqLimit);
    if (!ipCheck.allowed) {
      return { ok: false, reason: 'RATE_LIMIT_EXCEEDED', retry_scope: 'hour' };
    }

    const isRegistered = await this.isDeviceRegistered(deviceId);
    if (!isRegistered) {
      const ipDevKey = `ip_newdev:${ip}:${dayKey}`;
      const devCheck = await this.consumeRateLimit(ipDevKey, ipNewDevLimit);
      if (!devCheck.allowed) {
        return { ok: false, reason: 'DEVICE_CREATION_LIMIT', retry_scope: 'day' };
      }
    }

    return { ok: true, reason: null, retry_scope: null };
  }

  async recordSubmission(params) {
    // 1. Upsert device
    if (!this.devices.has(params.deviceId)) {
      this.devices.set(params.deviceId, {
        deviceId: params.deviceId,
        displayName: params.displayName,
        generatedName: params.displayName,
        nameHidden: false,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
    } else {
      const dev = this.devices.get(params.deviceId);
      dev.lastSeenAt = new Date().toISOString();
    }

    // 2. Duplicate check (events_hash per device)
    const isDup = await this.isDuplicateEvent(params.deviceId, params.eventsHash);
    if (isDup) {
      return { status: 'ALREADY_SUBMITTED', id: null };
    }

    // 3. Consume device counter
    const devCheck = await this.consumeRateLimit(params.devKey, params.devLimit);
    if (!devCheck.allowed) {
      return { status: 'DEVICE_LIMIT', id: null };
    }

    // 4. Record run
    const id = this.dailyRuns.length + 1;
    this.dailyRuns.push({
      id,
      deviceId: params.deviceId,
      dayUtc: params.dayUtc,
      seed: params.seed,
      points: params.points,
      totalMoves: params.totalMoves,
      maxTile: params.maxTile,
      relicsOwned: params.relics,
      replayVersion: params.replayVersion,
      eventsHash: params.eventsHash,
      durationMs: params.durationMs,
      flags: params.flags,
      finalBoard: params.finalBoard ?? null,
      receivedAt: new Date().toISOString(),
    });

    return { status: 'ACCEPTED', id };
  }

  // set-name adapter methods
  async setDisplayNameLimited(deviceId, newName, newNorm, dayKey, devLimit, ipKey, ipLimit) {
    const dev = this.devices.get(deviceId);
    if (!dev) {
      return { ok: false, status: 404, error: 'DEVICE_NOT_FOUND' };
    }

    // Check unique normalized name if setting a custom name
    if (newNorm) {
      for (const [id, d] of this.devices) {
        if (id !== deviceId && d.nameNorm === newNorm) {
          return { ok: false, status: 409, error: 'NAME_TAKEN' };
        }
      }
    }

    // Consume limits
    const devCheck = await this.consumeRateLimit(dayKey, devLimit);
    if (!devCheck.allowed) {
      return { ok: false, status: 429, error: 'DEVICE_DAILY_LIMIT_EXCEEDED' };
    }

    if (ipKey && ipLimit !== undefined) {
      const ipCheck = await this.consumeRateLimit(ipKey, ipLimit);
      if (!ipCheck.allowed) {
        return { ok: false, status: 429, error: 'IP_DAILY_LIMIT_EXCEEDED' };
      }
    }

    if (newName === null) {
      dev.displayName = dev.generatedName;
      dev.nameNorm = null;
      dev.nameHidden = false;
    } else {
      dev.displayName = newName;
      dev.nameNorm = newNorm;
      dev.nameHidden = false;
    }
    dev.nameChangedAt = new Date().toISOString();
    return { ok: true, status: 200, display_name: dev.displayName };
  }

  // Direct client simulation (Anon role context)
  anonQuery(table, action, payload = {}) {
    // Mock simulation of Postgres RLS enforcement based on 0001_leaderboard.sql & 0010_challenges.sql
    if (['devices', 'daily_runs', 'abuse_rate_limits', 'challenges'].includes(table)) {
      if (['insert', 'update', 'delete'].includes(action)) {
        throw new Error(`[MOCK RLS SIMULATION] permission denied for table "${table}": role "anon" has 0 policies`);
      }
      if (action === 'select') {
        return [];
      }
    }
    throw new Error(`Unknown table or action: ${table} ${action}`);
  }

  // Challenge adapter methods
  async consumeIpLimit(ip, hourKey, limit) {
    const key = `ip_req:${ip}:${hourKey}`;
    return this.consumeRateLimit(key, limit);
  }

  async consumeNewDeviceLimit(ip, dayKey, limit) {
    const key = `ip_newdev:${ip}:${dayKey}`;
    return this.consumeRateLimit(key, limit);
  }

  cleanupExpiredFreeChallenges(daysAgo = 7, limit = 100) {
    const cutoff = Date.now() - (daysAgo * 86400000);
    let count = 0;
    for (const [code, ch] of this.challenges.entries()) {
      if (ch.mode === 'free' && new Date(ch.expiresAt).getTime() < cutoff) {
        this.challenges.delete(code);
        count++;
        if (count >= limit) break;
      }
    }
    return count;
  }

  async createDailyChallenge(params) {
    this.cleanupExpiredFreeChallenges(7, 100);

    const todayUtc = new Date().toISOString().slice(0, 10);
    const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    let eligibleRuns = [];
    if (params.dayUtc) {
      eligibleRuns = this.dailyRuns.filter(r => r.deviceId === params.deviceId && r.dayUtc === params.dayUtc);
    } else {
      eligibleRuns = this.dailyRuns.filter(r => r.deviceId === params.deviceId && r.dayUtc === todayUtc);
      if (eligibleRuns.length === 0) {
        eligibleRuns = this.dailyRuns.filter(r => r.deviceId === params.deviceId && r.dayUtc === yesterdayUtc);
      }
    }

    if (eligibleRuns.length === 0) {
      return { status: 'NO_RUN' };
    }

    // Rank tie-breaker: points desc, total_moves desc, received_at asc, id asc
    eligibleRuns.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.totalMoves !== a.totalMoves) return b.totalMoves - a.totalMoves;
      const tA = new Date(a.receivedAt).getTime();
      const tB = new Date(b.receivedAt).getTime();
      if (tA !== tB) return tA - tB;
      return a.id - b.id;
    });

    const bestRun = eligibleRuns[0];

    // Idempotency: check if daily_run_id is already in challenges
    for (const ch of this.challenges.values()) {
      if (ch.mode === 'daily' && ch.dailyRunId === bestRun.id) {
        return { status: 'IDEMPOTENT', code: ch.code, expires_at: ch.expiresAt };
      }
    }

    // Rate limit
    if (params.limitKey) {
      const check = await this.consumeRateLimit(params.limitKey, params.limit);
      if (!check.allowed) {
        return { status: 'LIMIT_EXCEEDED' };
      }
    }

    if (this.challenges.has(params.code)) {
      return { status: 'COLLISION' };
    }

    const expiresAt = `${bestRun.dayUtc}T23:59:59.999Z`;
    const challenge = {
      code: params.code,
      creatorDeviceId: params.deviceId,
      mode: 'daily',
      dayUtc: bestRun.dayUtc,
      dailyRunId: bestRun.id,
      points: bestRun.points,
      totalMoves: bestRun.totalMoves,
      maxTile: bestRun.maxTile,
      relicsOwned: bestRun.relicsOwned || [],
      seed: bestRun.seed,
      finalBoard: bestRun.finalBoard ?? null,
      replayVersion: bestRun.replayVersion,
      eventsHash: bestRun.eventsHash,
      createdAt: new Date().toISOString(),
      expiresAt,
      open_count: 0,
      accept_count: 0,
    };

    this.challenges.set(params.code, challenge);
    return { status: 'CREATED', code: params.code, expires_at: expiresAt };
  }

  async createFreeChallenge(params) {
    this.cleanupExpiredFreeChallenges(7, 100);

    // Auto-register device if unknown
    if (!this.devices.has(params.deviceId)) {
      this.devices.set(params.deviceId, {
        deviceId: params.deviceId,
        displayName: params.displayName,
        generatedName: params.displayName,
        nameHidden: false,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
    } else {
      const dev = this.devices.get(params.deviceId);
      dev.lastSeenAt = new Date().toISOString();
    }

    // Idempotency check: (creator_device_id, events_hash)
    for (const ch of this.challenges.values()) {
      if (ch.mode === 'free' && ch.creatorDeviceId === params.deviceId && ch.eventsHash === params.eventsHash) {
        return { status: 'IDEMPOTENT', code: ch.code, expires_at: ch.expiresAt };
      }
    }

    // Rate limit
    if (params.limitKey) {
      const check = await this.consumeRateLimit(params.limitKey, params.limit);
      if (!check.allowed) {
        return { status: 'LIMIT_EXCEEDED' };
      }
    }

    if (this.challenges.has(params.code)) {
      return { status: 'COLLISION' };
    }

    const challenge = {
      code: params.code,
      creatorDeviceId: params.deviceId,
      mode: 'free',
      dayUtc: null,
      dailyRunId: null,
      points: params.points,
      totalMoves: params.totalMoves,
      maxTile: params.maxTile,
      relicsOwned: params.relics || [],
      seed: params.seed,
      finalBoard: params.finalBoard ?? null,
      replayVersion: params.replayVersion,
      eventsHash: params.eventsHash,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      open_count: 0,
      accept_count: 0,
    };

    this.challenges.set(params.code, challenge);
    return { status: 'CREATED', code: params.code, expires_at: params.expiresAt };
  }

  async recordChallengeEvent(code, kind) {
    if (!code || !/^[A-Za-z0-9]{12}$/.test(code)) return false;
    const ch = this.challenges.get(code);
    if (!ch) return false;
    if (new Date(ch.expiresAt).getTime() <= Date.now()) return false;
    if (kind === 'open') {
      ch.open_count = (ch.open_count || 0) + 1;
      return true;
    } else if (kind === 'accept') {
      ch.accept_count = (ch.accept_count || 0) + 1;
      return true;
    }
    return false;
  }

  rpcGetChallenge(code) {
    if (!code || typeof code !== 'string' || !/^[A-Za-z0-9]{12}$/.test(code)) {
      return { status: 'not_found' };
    }

    const ch = this.challenges.get(code);
    if (!ch) {
      return { status: 'not_found' };
    }

    const isExpired = new Date(ch.expiresAt).getTime() <= Date.now();
    const status = isExpired ? 'expired' : 'valid';

    const dev = this.devices.get(ch.creatorDeviceId);
    const sender_display_name = dev
      ? (dev.nameHidden ? dev.generatedName : (dev.displayName || dev.generatedName))
      : null;

    if (ch.mode === 'daily') {
      let run = this.dailyRuns.find(r => r.id === ch.dailyRunId);
      if (!run) {
        run = {
          points: ch.points,
          totalMoves: ch.totalMoves,
          maxTile: ch.maxTile,
          relicsOwned: ch.relicsOwned,
          finalBoard: ch.finalBoard,
          dayUtc: ch.dayUtc,
        };
      }

      let sender_rank = null;
      let total_players = null;
      if (run.dayUtc && ch.creatorDeviceId) {
        const rankInfo = this.rpcMyDailyRank(run.dayUtc, ch.creatorDeviceId);
        if (rankInfo && rankInfo.length > 0) {
          sender_rank = rankInfo[0].rank;
          total_players = rankInfo[0].total_players;
        }
      }

      return {
        status,
        mode: 'daily',
        sender_display_name,
        points: run.points,
        total_moves: run.totalMoves,
        max_tile: run.maxTile,
        relics_owned: run.relicsOwned || [],
        final_board: run.finalBoard ?? null,
        day_utc: run.dayUtc,
        created_at: ch.createdAt,
        expires_at: ch.expiresAt,
        sender_rank,
        total_players,
      };
    } else {
      return {
        status,
        mode: 'free',
        sender_display_name,
        points: ch.points,
        total_moves: ch.totalMoves,
        max_tile: ch.maxTile,
        relics_owned: ch.relicsOwned || [],
        final_board: ch.finalBoard ?? null,
        seed: ch.seed !== null && ch.seed !== undefined ? Number(ch.seed) : null,
        created_at: ch.createdAt,
        expires_at: ch.expiresAt,
      };
    }
  }

  // Public RPC functions
  rpcDailyBest(targetDay, limit = 100) {
    return computeDailyBest(this.dailyRuns, this.devices, targetDay, limit);
  }

  rpcMyDailyRank(targetDay, deviceId) {
    return computeMyDailyRank(this.dailyRuns, this.devices, targetDay, deviceId);
  }

  rpcWeeklyBest(targetWeekStart = null, limit = 100) {
    return computeWeeklyBest(this.dailyRuns, this.devices, targetWeekStart, limit);
  }

  rpcMyWeeklyRank(targetWeekStart, deviceId) {
    return computeMyWeeklyRank(this.dailyRuns, this.devices, targetWeekStart, deviceId);
  }

  rpcAlltimeBest(limit = 100) {
    return computeAlltimeBest(this.dailyRuns, this.devices, limit);
  }

  rpcMyAlltimeRank(deviceId) {
    return computeMyAlltimeRank(this.dailyRuns, this.devices, deviceId);
  }
}
