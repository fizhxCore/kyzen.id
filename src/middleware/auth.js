const crypto = require("crypto");
const redis = require("../utils/redis");

const DEV_SECRET = process.env.DEV_SECRET || "";

function isDevAuthorized(req) {
    if (!DEV_SECRET) return false;
    const key = req.headers["x-dev-key"] || req.query.key;
    return key === DEV_SECRET;
}

// ========== API KEY SYSTEM ==========
const API_KEYS_SET = "apikeys:all";

// Endpoint yang wajib pakai API key (yang berat/numpang layanan pihak ketiga sensitif)
const PROTECTED_PREFIXES = ["/ai/"];
const PROTECTED_EXACT = ["/download/all"];

function isProtectedRoute(reqPath) {
    if (PROTECTED_EXACT.includes(reqPath)) return true;
    return PROTECTED_PREFIXES.some((p) => reqPath.startsWith(p));
}

function generateApiKey() {
    return "kyz_" + crypto.randomBytes(24).toString("hex");
}

async function createApiKey(label) {
    const key = generateApiKey();
    const data = { label: label || "unnamed", created_at: new Date().toISOString(), usage: 0, last_used: null };

    const savedData = await redis.redisSafeSet(`apikey:${key}`, data);
    const savedIndex = await redis.redisSafeSAdd(API_KEYS_SET, key);

    if (!savedData || !savedIndex) {
        return { key: null, error: redis.getLastRedisError() || "Gagal menyimpan key ke Redis" };
    }

    return { key, error: null };
}

async function listApiKeys() {
    const keys = await redis.redisSafeSMembers(API_KEYS_SET);
    const result = [];
    for (const key of keys) {
        const data = await redis.redisSafeGet(`apikey:${key}`, null);
        if (!data || typeof data !== "object") continue;
        result.push({ key, ...data });
    }
    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function revokeApiKey(key) {
    await redis.redisSafeDel(`apikey:${key}`);
    await redis.redisSafeSRem(API_KEYS_SET, key);
}

async function validateApiKey(key) {
    if (!key) return false;
    const data = await redis.redisSafeGet(`apikey:${key}`, null);
    if (!data || typeof data !== "object") return false;

    data.usage = (data.usage || 0) + 1;
    data.last_used = new Date().toISOString();
    redis.redisSafeSet(`apikey:${key}`, data);

    return true;
}

// ========== API KEY CHECK (middleware) ==========
async function apiKeyCheckMiddleware(req, res, next) {
    if (!isProtectedRoute(req.path)) return next();

    const key = req.headers["x-api-key"] || req.query.apikey;
    const valid = await validateApiKey(key);

    if (!valid) {
        return res.status(401).json({
            status: false,
            error: "Endpoint ini butuh API key yang valid. Kirim lewat header 'x-api-key' atau query '?apikey='",
        });
    }

    next();
}

module.exports = {
    isDevAuthorized,
    PROTECTED_PREFIXES,
    PROTECTED_EXACT,
    isProtectedRoute,
    createApiKey,
    listApiKeys,
    revokeApiKey,
    validateApiKey,
    apiKeyCheckMiddleware,
};
