const redis = require("./redis");

// ========== ERROR LOG (buat admin panel — biar admin bisa lihat error asli, bukan cuma angka) ==========
const ERROR_LOG_KEY = "logs:errors";
const MAX_ERRORS = 50;

// Fallback in-memory kalau Redis belum di-setup, biar tetap kepantau pas dev/local.
let memoryLog = [];

async function recordError({ method, endpoint, statusCode, message, ip, source }) {
    const entry = {
        method: method || "-",
        endpoint: endpoint || "-",
        statusCode: statusCode || 500,
        message: (message || "Unknown error").toString().slice(0, 500),
        ip: ip || "-",
        source: source || "handler", // "handler" | "response" | "uncaught"
        timestamp: new Date().toISOString(),
    };

    try {
        if (redis.isRedisEnabled()) {
            await redis.redisSafeLPush(ERROR_LOG_KEY, entry);
            await redis.redisSafeLTrim(ERROR_LOG_KEY, 0, MAX_ERRORS - 1);
        } else {
            memoryLog.unshift(entry);
            if (memoryLog.length > MAX_ERRORS) memoryLog = memoryLog.slice(0, MAX_ERRORS);
        }
    } catch {
        // logging error log gak boleh sampai ganggu request utama
    }
}

async function getRecentErrors(limit = MAX_ERRORS) {
    if (redis.isRedisEnabled()) {
        const raw = await redis.redisSafeLRange(ERROR_LOG_KEY, 0, limit - 1);
        return raw.map((item) => (typeof item === "string" ? safeParse(item) : item)).filter(Boolean);
    }
    return memoryLog.slice(0, limit);
}

function safeParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

module.exports = {
    recordError,
    getRecentErrors,
};
