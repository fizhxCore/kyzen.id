const chalk = require("chalk");

// ========== UPSTASH REDIS (fail-safe: nonaktif tanpa bikin crash kalau env var belum diisi) ==========
let redisClient = null;
let redisEnabled = false;
let lastRedisError = null;

try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        const { Redis } = require("@upstash/redis");
        redisClient = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        redisEnabled = true;
    }
} catch (err) {
    console.warn(chalk.yellow(`⚠️ Upstash Redis init gagal: ${err.message}`));
}

function isRedisEnabled() {
    return redisEnabled;
}

function getLastRedisError() {
    return lastRedisError;
}

async function redisSafeGet(key, fallback = null) {
    if (!redisEnabled) return fallback;
    try {
        const val = await redisClient.get(key);
        return val === null || val === undefined ? fallback : val;
    } catch {
        return fallback;
    }
}

async function redisSafeSet(key, value) {
    if (!redisEnabled) return false;
    try {
        await redisClient.set(key, value);
        return true;
    } catch (err) {
        console.error(chalk.red(`[Redis SET Error] ${err.message}`));
        lastRedisError = err.message;
        return false;
    }
}

async function redisSafeIncr(key) {
    if (!redisEnabled) return null;
    try {
        return await redisClient.incr(key);
    } catch {
        return null;
    }
}

async function redisSafeHIncrBy(key, field, amount = 1) {
    if (!redisEnabled) return null;
    try {
        return await redisClient.hincrby(key, field, amount);
    } catch {
        return null;
    }
}

async function redisSafeHGetAll(key) {
    if (!redisEnabled) return {};
    try {
        const val = await redisClient.hgetall(key);
        return val || {};
    } catch {
        return {};
    }
}

async function redisSafeExpire(key, seconds) {
    if (!redisEnabled) return false;
    try {
        await redisClient.expire(key, seconds);
        return true;
    } catch {
        return false;
    }
}

async function redisSafeDel(key) {
    if (!redisEnabled) return false;
    try {
        await redisClient.del(key);
        return true;
    } catch {
        return false;
    }
}

async function redisSafeSAdd(key, member) {
    if (!redisEnabled) return false;
    try {
        await redisClient.sadd(key, member);
        return true;
    } catch (err) {
        console.error(chalk.red(`[Redis SADD Error] ${err.message}`));
        lastRedisError = err.message;
        return false;
    }
}

async function redisSafeSRem(key, member) {
    if (!redisEnabled) return false;
    try {
        await redisClient.srem(key, member);
        return true;
    } catch {
        return false;
    }
}

async function redisSafeSMembers(key) {
    if (!redisEnabled) return [];
    try {
        const members = await redisClient.smembers(key);
        return members || [];
    } catch {
        return [];
    }
}

module.exports = {
    isRedisEnabled,
    getLastRedisError,
    redisSafeGet,
    redisSafeSet,
    redisSafeIncr,
    redisSafeHIncrBy,
    redisSafeHGetAll,
    redisSafeExpire,
    redisSafeDel,
    redisSafeSAdd,
    redisSafeSRem,
    redisSafeSMembers,
};
