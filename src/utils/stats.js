const redis = require("./redis");
const logger = require("./logger");

// ========== STATS (tracking request/error ke Redis) ==========
function todayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function hourKey() {
    const d = new Date();
    return `${todayKey()}-${String(d.getUTCHours()).padStart(2, "0")}`;
}

async function recordRequestStat(endpoint, statusCode) {
    if (!redis.isRedisEnabled()) return;

    const isError = statusCode >= 400;
    const today = todayKey();
    const hour = hourKey();
    const endpointHourKey = `stats:ep_hourly:${endpoint}:${hour}`;

    try {
        await Promise.all([
            redis.redisSafeIncr("stats:total:all_time"),
            redis.redisSafeIncr(`stats:total:${today}`),
            redis.redisSafeIncr(`stats:hourly:${hour}`),
            redis.redisSafeHIncrBy("stats:endpoints:all_time", endpoint, 1),
            redis.redisSafeHIncrBy(`stats:endpoints:${today}`, endpoint, 1),
            redis.redisSafeHIncrBy(endpointHourKey, "total", 1),
            isError ? redis.redisSafeIncr("stats:errors:all_time") : Promise.resolve(),
            isError ? redis.redisSafeIncr(`stats:errors:${today}`) : Promise.resolve(),
            isError ? redis.redisSafeHIncrBy("stats:errors:endpoints", endpoint, 1) : Promise.resolve(),
            isError ? redis.redisSafeHIncrBy(endpointHourKey, "errors", 1) : Promise.resolve(),
        ]);

        redis.redisSafeExpire(`stats:hourly:${hour}`, 60 * 60 * 48);
        redis.redisSafeExpire(endpointHourKey, 60 * 60 * 2);

        if (isError) await checkErrorAlert(endpoint, endpointHourKey);
    } catch {
        // stats tidak boleh sampai bikin request utama gagal
    }
}

const ALERT_MIN_ERRORS = 3;
const ALERT_MIN_RATE = 0.5;
const ALERT_COOLDOWN_SECONDS = 30 * 60;

async function checkErrorAlert(endpoint, endpointHourKey) {
    try {
        const stat = await redis.redisSafeHGetAll(endpointHourKey);
        const total = Number(stat.total) || 0;
        const errors = Number(stat.errors) || 0;
        if (errors < ALERT_MIN_ERRORS) return;
        if (errors / total < ALERT_MIN_RATE) return;

        const cooldownKey = `alert:cooldown:${endpoint}`;
        const onCooldown = await redis.redisSafeGet(cooldownKey, null);
        if (onCooldown) return;

        await redis.redisSafeSet(cooldownKey, "1");
        redis.redisSafeExpire(cooldownKey, ALERT_COOLDOWN_SECONDS);

        const rate = ((errors / total) * 100).toFixed(0);
        logger.sendWebhook(null, [
            {
                title: "🚨 Endpoint Bermasalah",
                color: 0xed4245,
                fields: [
                    { name: "Endpoint", value: `\`${endpoint}\`` },
                    { name: "Error Rate (1 jam terakhir)", value: `${errors}/${total} (${rate}%)`, inline: true },
                    { name: "Waktu", value: new Date().toISOString(), inline: true },
                ],
                footer: { text: "Kyzen.id Alert System — nggak akan alert lagi buat endpoint ini selama 30 menit" },
                timestamp: new Date(),
            },
        ]);
    } catch {
        // alert gagal kirim juga jangan sampai ganggu request utama
    }
}

async function getDashboardStats() {
    const today = todayKey();

    const [totalAllTime, totalToday, errorsAllTime, errorsToday, endpointsAllTime, errorEndpoints] = await Promise.all([
        redis.redisSafeGet("stats:total:all_time", 0),
        redis.redisSafeGet(`stats:total:${today}`, 0),
        redis.redisSafeGet("stats:errors:all_time", 0),
        redis.redisSafeGet(`stats:errors:${today}`, 0),
        redis.redisSafeHGetAll("stats:endpoints:all_time"),
        redis.redisSafeHGetAll("stats:errors:endpoints"),
    ]);

    const hourly = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
        const count = await redis.redisSafeGet(`stats:hourly:${key}`, 0);
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

module.exports = {
    recordRequestStat,
    getDashboardStats,
};
