// scripts/live_safety.js
// Common safety rails for live test scripts and cleanup operations

export async function assertDatabaseSafe(serviceClient, isCleanScript = false, simulate = false) {
  let dailyRunsCount = 0;
  let devicesCount = 0;

  if (simulate) {
    dailyRunsCount = 250;
    devicesCount = 150;
    console.log(`[SAFETY CHECK - SIMULATED] Target rows: daily_runs=${dailyRunsCount} (limit: 200), devices=${devicesCount} (limit: 100)`);
  } else {
    const [runsRes, devsRes] = await Promise.all([
      serviceClient.from('daily_runs').select('*', { count: 'exact', head: true }),
      serviceClient.from('devices').select('*', { count: 'exact', head: true }),
    ]);
    dailyRunsCount = runsRes.count || 0;
    devicesCount = devsRes.count || 0;
    console.log(`[SAFETY CHECK] Target rows: daily_runs=${dailyRunsCount} (limit: 200), devices=${devicesCount} (limit: 100)`);
  }

  const isPopulated = dailyRunsCount > 200 || devicesCount > 100;
  if (isPopulated) {
    if (isCleanScript) {
      if (process.env.I_UNDERSTAND_THIS_WIPES_DATA !== '1') {
        throw new Error(
          `${simulate ? '[SIMULATED] ' : ''}REFUSING TO RUN: Target database has ${dailyRunsCount} daily_runs (>200) and ${devicesCount} devices (>100). Set I_UNDERSTAND_THIS_WIPES_DATA=1 to override.`
        );
      }
    } else {
      if (process.env.ALLOW_LIVE_ON_POPULATED !== '1') {
        throw new Error(
          `${simulate ? '[SIMULATED] ' : ''}REFUSING TO RUN: Target database has ${dailyRunsCount} daily_runs (>200) and ${devicesCount} devices (>100). Set ALLOW_LIVE_ON_POPULATED=1 to override.`
        );
      }
    }
  }
}

