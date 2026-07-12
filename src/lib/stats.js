const redis = require("./redis");

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function hourKey() {
  const d = new Date();
  return `${todayKey()}-${String(d.getUTCHours()).padStart(2, "0")}`;
}

// Dipanggil tanpa "await" dari middleware supaya nggak nambah latency ke response utama.
async function recordRequest(endpoint, statusCode) {
  if (!redis.isEnabled()) return;

  const isError = statusCode >= 400;
  const today = todayKey();
  const hour = hourKey();

  try {
    await Promise.all([
      redis.safeIncr("stats:total:all_time"),
      redis.safeIncr(`stats:total:${today}`),
      redis.safeIncr(`stats:hourly:${hour}`),
      redis.safeHIncrBy("stats:endpoints:all_time", endpoint, 1),
      redis.safeHIncrBy(`stats:endpoints:${today}`, endpoint, 1),
      isError ? redis.safeIncr("stats:errors:all_time") : Promise.resolve(),
      isError ? redis.safeIncr(`stats:errors:${today}`) : Promise.resolve(),
      isError ? redis.safeHIncrBy("stats:errors:endpoints", endpoint, 1) : Promise.resolve(),
    ]);

    // Expire data per-jam setelah 48 jam biar Redis nggak numpuk data lama terus
    redis.safeExpire(`stats:hourly:${hour}`, 60 * 60 * 48);
  } catch {
    // diamkan, stats tidak boleh sampai bikin request utama gagal
  }
}

async function getStats() {
  const today = todayKey();

  const [totalAllTime, totalToday, errorsAllTime, errorsToday, endpointsAllTime, errorEndpoints] = await Promise.all([
    redis.safeGet("stats:total:all_time", 0),
    redis.safeGet(`stats:total:${today}`, 0),
    redis.safeGet("stats:errors:all_time", 0),
    redis.safeGet(`stats:errors:${today}`, 0),
    redis.safeHGetAll("stats:endpoints:all_time"),
    redis.safeHGetAll("stats:errors:endpoints"),
  ]);

  // Ambil data 24 jam terakhir buat grafik
  const hourly = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
    const count = await redis.safeGet(`stats:hourly:${key}`, 0);
    hourly.push({ hour: `${d.getUTCHours()}:00`, count: Number(count) || 0 });
  }

  const topEndpoints = Object.entries(endpointsAllTime)
    .map(([endpoint, count]) => ({ endpoint, count: Number(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topErrors = Object.entries(errorEndpoints)
    .map(([endpoint, count]) => ({ endpoint, count: Number(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const totalAllTimeNum = Number(totalAllTime) || 0;
  const errorsAllTimeNum = Number(errorsAllTime) || 0;

  return {
    totalAllTime: totalAllTimeNum,
    totalToday: Number(totalToday) || 0,
    errorsAllTime: errorsAllTimeNum,
    errorsToday: Number(errorsToday) || 0,
    errorRate: totalAllTimeNum > 0 ? ((errorsAllTimeNum / totalAllTimeNum) * 100).toFixed(1) : "0.0",
    hourly,
    topEndpoints,
    topErrors,
  };
}

module.exports = { recordRequest, getStats };
