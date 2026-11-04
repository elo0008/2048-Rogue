// scripts/lib/inmemory_db.js
// Shared in-memory database engine simulating PostgreSQL RLS, submit-run RPCs, and set-name RPCs

export class SecurityDatabaseEngine {
  constructor() {
    this.devices = new Map();
    this.dailyRuns = [];
    this.rateLimits = new Map();
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
      receivedAt: new Date().toISOString(),
    });

    return { status: 'ACCEPTED', id };
  }

  // set-name adapter methods
  async setDisplayNameLimited(deviceId, newName, newNorm, dayKey, devLimit, ipKey, ipLimit) {
    const dev = this.devices.get(deviceId);
    if (!dev) {
      return { status: 'DEVICE_NOT_FOUND' };
    }

    // Check unique normalized name if setting a custom name
    if (newNorm) {
      for (const [id, d] of this.devices) {
        if (id !== deviceId && d.nameNorm === newNorm) {
          return { status: 'NAME_TAKEN' };
        }
      }
    }

    // Consume limits
    const devCheck = await this.consumeRateLimit(dayKey, devLimit);
    if (!devCheck.allowed) {
      return { status: 'DEVICE_LIMIT' };
    }

    const ipCheck = await this.consumeRateLimit(ipKey, ipLimit);
    if (!ipCheck.allowed) {
      return { status: 'IP_LIMIT' };
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
    return { status: 'OK', displayName: dev.displayName };
  }

  // Direct client simulation (Anon role context)
  anonQuery(table, action, payload = {}) {
    // Mock simulation of Postgres RLS enforcement based on 0001_leaderboard.sql
    if (['devices', 'daily_runs', 'abuse_rate_limits'].includes(table)) {
      if (['insert', 'update', 'delete'].includes(action)) {
        throw new Error(`[MOCK RLS SIMULATION] permission denied for table "${table}": role "anon" has 0 policies`);
      }
      if (action === 'select') {
        return [];
      }
    }
    throw new Error(`Unknown table or action: ${table} ${action}`);
  }

  // Public RPC function: daily_best(target_day)
  rpcDailyBest(targetDay) {
    const perDevice = new Map();
    for (const r of this.dailyRuns) {
      if (r.dayUtc !== targetDay) continue;
      const cur = perDevice.get(r.deviceId);
      // Spec: points DESC, total_moves DESC (more moves survived wins), received_at ASC, id ASC
      if (!cur) {
        perDevice.set(r.deviceId, r);
      } else {
        const movesR = r.totalMoves || r.moves || 0;
        const movesCur = cur.totalMoves || cur.moves || 0;
        let better = false;
        if (r.points > cur.points) better = true;
        else if (r.points === cur.points) {
          if (movesR > movesCur) better = true;
          else if (movesR === movesCur) {
            if (r.receivedAt < cur.receivedAt) better = true;
            else if (r.receivedAt === cur.receivedAt) {
              if (r.id < cur.id) better = true;
            }
          }
        }
        if (better) perDevice.set(r.deviceId, r);
      }
    }

    const bests = Array.from(perDevice.values());
    bests.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const movesA = a.totalMoves || a.moves || 0;
      const movesB = b.totalMoves || b.moves || 0;
      if (movesB !== movesA) return movesB - movesA;
      if (a.receivedAt !== b.receivedAt) return a.receivedAt.localeCompare(b.receivedAt);
      return a.id - b.id;
    });

    // Expose ONLY allowed columns (display_name, points, total_moves, max_tile, rank)
    return bests.map((b, idx) => {
      const dev = this.devices.get(b.deviceId);
      const displayName = dev
        ? (dev.nameHidden ? dev.generatedName : (dev.displayName || dev.generatedName))
        : 'Unknown';
      return {
        display_name: displayName,
        points: b.points,
        total_moves: b.totalMoves || b.moves || 0,
        max_tile: b.maxTile,
        rank: idx + 1,
      };
    });
  }

  // Public RPC function: my_daily_rank(target_day, p_device_id)
  rpcMyDailyRank(targetDay, deviceId) {
    const list = this.rpcDailyBest(targetDay);
    const total_players = list.length;
    const hasRun = this.dailyRuns.some(r => r.dayUtc === targetDay && r.deviceId === deviceId);
    if (!hasRun) return [];

    const dev = this.devices.get(deviceId);
    const expectedName = dev
      ? (dev.nameHidden ? dev.generatedName : (dev.displayName || dev.generatedName))
      : 'Unknown';

    const match = list.find(r => r.display_name === expectedName);
    if (!match) return [];
    return [{
      rank: match.rank,
      total_players,
      display_name: match.display_name,
      points: match.points,
    }];
  }
}
