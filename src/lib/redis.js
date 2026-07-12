const { Redis } = require("@upstash/redis");

let client = null;
let enabled = false;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  client = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  enabled = true;
}

function isEnabled() {
  return enabled;
}

// Semua fungsi di bawah "fail-safe": kalau Redis belum di-setup atau lagi error,
// jangan sampai bikin request utama ikut gagal. Cukup no-op / return default.

async function safeGet(key, fallback = null) {
  if (!enabled) return fallback;
  try {
    const val = await client.get(key);
    return val === null || val === undefined ? fallback : val;
  } catch {
    return fallback;
  }
}

async function safeSet(key, value) {
  if (!enabled) return false;
  try {
    await client.set(key, value);
    return true;
  } catch {
    return false;
  }
}

async function safeIncr(key) {
  if (!enabled) return null;
  try {
    return await client.incr(key);
  } catch {
    return null;
  }
}

async function safeHIncrBy(key, field, amount = 1) {
  if (!enabled) return null;
  try {
    return await client.hincrby(key, field, amount);
  } catch {
    return null;
  }
}

async function safeHGetAll(key) {
  if (!enabled) return {};
  try {
    const val = await client.hgetall(key);
    return val || {};
  } catch {
    return {};
  }
}

async function safeExpire(key, seconds) {
  if (!enabled) return false;
  try {
    await client.expire(key, seconds);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isEnabled,
  safeGet,
  safeSet,
  safeIncr,
  safeHIncrBy,
  safeHGetAll,
  safeExpire,
};
