const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const chalk = require("chalk");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;
const DEV_SECRET = process.env.DEV_SECRET || "";

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
    if (!redisEnabled) return;

    const isError = statusCode >= 400;
    const today = todayKey();
    const hour = hourKey();
    const endpointHourKey = `stats:ep_hourly:${endpoint}:${hour}`;

    try {
        await Promise.all([
            redisSafeIncr("stats:total:all_time"),
            redisSafeIncr(`stats:total:${today}`),
            redisSafeIncr(`stats:hourly:${hour}`),
            redisSafeHIncrBy("stats:endpoints:all_time", endpoint, 1),
            redisSafeHIncrBy(`stats:endpoints:${today}`, endpoint, 1),
            redisSafeHIncrBy(endpointHourKey, "total", 1),
            isError ? redisSafeIncr("stats:errors:all_time") : Promise.resolve(),
            isError ? redisSafeIncr(`stats:errors:${today}`) : Promise.resolve(),
            isError ? redisSafeHIncrBy("stats:errors:endpoints", endpoint, 1) : Promise.resolve(),
            isError ? redisSafeHIncrBy(endpointHourKey, "errors", 1) : Promise.resolve(),
        ]);

        redisSafeExpire(`stats:hourly:${hour}`, 60 * 60 * 48);
        redisSafeExpire(endpointHourKey, 60 * 60 * 2);

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
        const stat = await redisSafeHGetAll(endpointHourKey);
        const total = Number(stat.total) || 0;
        const errors = Number(stat.errors) || 0;
        if (errors < ALERT_MIN_ERRORS) return;
        if (errors / total < ALERT_MIN_RATE) return;

        const cooldownKey = `alert:cooldown:${endpoint}`;
        const onCooldown = await redisSafeGet(cooldownKey, null);
        if (onCooldown) return;

        await redisSafeSet(cooldownKey, "1");
        redisSafeExpire(cooldownKey, ALERT_COOLDOWN_SECONDS);

        const rate = ((errors / total) * 100).toFixed(0);
        sendWebhook(null, [
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
        redisSafeGet("stats:total:all_time", 0),
        redisSafeGet(`stats:total:${today}`, 0),
        redisSafeGet("stats:errors:all_time", 0),
        redisSafeGet(`stats:errors:${today}`, 0),
        redisSafeHGetAll("stats:endpoints:all_time"),
        redisSafeHGetAll("stats:errors:endpoints"),
    ]);

    const hourly = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
        const count = await redisSafeGet(`stats:hourly:${key}`, 0);
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

// ========== MAINTENANCE MODE ==========
const MAINTENANCE_KEY = "config:maintenance";

async function isMaintenanceOn() {
    const val = await redisSafeGet(MAINTENANCE_KEY, "off");
    return val === "on" || val === true;
}

async function setMaintenance(on) {
    return redisSafeSet(MAINTENANCE_KEY, on ? "on" : "off");
}

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

    const savedData = await redisSafeSet(`apikey:${key}`, JSON.stringify(data));
    const savedIndex = await redisSafeSAdd(API_KEYS_SET, key);

    if (!savedData || !savedIndex) {
        return { key: null, error: lastRedisError || "Gagal menyimpan key ke Redis" };
    }

    return { key, error: null };
}

async function listApiKeys() {
    const keys = await redisSafeSMembers(API_KEYS_SET);
    const result = [];
    for (const key of keys) {
        const raw = await redisSafeGet(`apikey:${key}`, null);
        if (!raw) continue;
        try {
            const data = JSON.parse(raw);
            result.push({ key, ...data });
        } catch {}
    }
    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function revokeApiKey(key) {
    await redisSafeDel(`apikey:${key}`);
    await redisSafeSRem(API_KEYS_SET, key);
}

async function validateApiKey(key) {
    if (!key) return false;
    const raw = await redisSafeGet(`apikey:${key}`, null);
    if (!raw) return false;

    try {
        const data = JSON.parse(raw);
        data.usage = (data.usage || 0) + 1;
        data.last_used = new Date().toISOString();
        redisSafeSet(`apikey:${key}`, JSON.stringify(data));
    } catch {}

    return true;
}

// ========== DISCORD WEBHOOK ==========
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function sendWebhook(content, embeds = null) {
    if (!WEBHOOK_URL) return;

    try {
        await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                embeds
                    ? { content: content || null, embeds }
                    : { content }
            )
        });
    } catch (err) {
        console.error(chalk.red(`[WebhookError] ${err.message}`));
    }
}

// ========== KIRIM NOTIF ==========
async function sendNotification(msg) {
    sendWebhook(msg);
}

// ========== KIRIM LOG API ==========
async function sendLog({ ip, method, endpoint, status, query, duration }) {
    const icons = { request: "🟡", success: "✅", error: "❌" };
    const colors = { request: 0x7289da, success: 0x57f287, error: 0xed4245 };

    const embed = [
        {
            title: `${icons[status]} API Activity - ${status.toUpperCase()}`,
            color: colors[status],
            fields: [
                { name: "IP", value: `\`${ip}\``, inline: true },
                { name: "Method", value: method, inline: true },
                { name: "Endpoint", value: endpoint },
                {
                    name: "Query",
                    value: `\`\`\`json\n${JSON.stringify(query || {}, null, 2)}\n\`\`\``
                },
                { name: "Duration", value: `${duration ?? "-"}ms`, inline: true },
                { name: "Time", value: new Date().toISOString() }
            ],
            footer: { text: "Kyzen.id Log System ✨" },
            timestamp: new Date()
        }
    ];

    sendWebhook(null, embed);
}

// ========== EXPRESS ==========
app.enable("trust proxy");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.set("json spaces", 2);

// ========== MAINTENANCE MODE CHECK ==========
app.use(async (req, res, next) => {
    // Rute /dev/* tetap bisa diakses walau maintenance nyala
    if (req.path.startsWith("/dev/") || req.path === "/health") return next();

    const isOn = await isMaintenanceOn();
    if (!isOn) return next();

    const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/download") || req.path.startsWith("/image") || req.path.startsWith("/ai") || req.path.startsWith("/anime") || req.path.startsWith("/news");

    if (wantsJson) {
        return res.status(503).json({ status: false, maintenance: true, message: "API sedang dalam perbaikan, coba lagi nanti" });
    }

    return res.status(503).sendFile(path.join(__dirname, "api-page", "maintenance.html"));
});

// ========== API KEY CHECK ==========
app.use(async (req, res, next) => {
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
});

// ========== STATIC FILES ==========
app.use("/", express.static(path.join(__dirname, "api-page")));
app.use("/src", express.static(path.join(__dirname, "src")));

// ========== LOAD OPENAPI ==========
const openApiPath = path.join(__dirname, "./src/openapi.json");
let openApi = {};

try {
    openApi = JSON.parse(fs.readFileSync(openApiPath));
} catch {
    console.warn(chalk.yellow("⚠️ openapi.json not found or invalid."));
}

// ========== /health route ==========
app.get("/health", (req, res) => {
    res.json({
        status: true,
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        redis: redisEnabled,
    });
});

// ========== /openapi.json route ==========
app.get("/openapi.json", (req, res) => {
    if (fs.existsSync(openApiPath)) res.sendFile(openApiPath);
    else res.status(404).json({ status: false, message: "openapi.json tidak ditemukan" });
});

// ========== Helper match path OpenAPI ==========
function matchOpenApiPath(requestPath) {
    const paths = Object.keys(openApi.paths || {});
    for (const apiPath of paths) {
        const regex = new RegExp("^" + apiPath.replace(/{[^}]+}/g, "[^/]+") + "$");
        if (regex.test(requestPath)) return true;
    }
    return false;
}

// ========== JSON RESPONSE WRAPPER ==========
app.use((req, res, next) => {
    const original = res.json;
    res.json = function (data) {
        if (typeof data === "object") {
            data = {
                status: data.status ?? true,
                creator: openApi.info?.author || "Kyzen.id",
                ...data
            };
        }
        return original.call(this, data);
    };
    next();
});

// ========== ENDPOINT LOGGER ==========
const endpointStats = {};

app.use(async (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const method = req.method;
    const endpoint = req.originalUrl.split("?")[0];
    const query = req.query;
    const start = Date.now();

    try {
        // REQUEST LOG
        if (matchOpenApiPath(endpoint)) {
            sendLog({ ip, method, endpoint, status: "request", query });
            console.log(chalk.yellow(`🟡 [REQUEST] ${method} ${endpoint} | IP: ${ip}`));
        }

        next();

        res.on("finish", () => {
            if (!matchOpenApiPath(endpoint)) return;

            const duration = Date.now() - start;
            const isError = res.statusCode >= 400;
            const status = isError ? "error" : "success";

            if (!endpointStats[endpoint]) endpointStats[endpoint] = { total: 0, errors: 0, totalDuration: 0 };
            endpointStats[endpoint].total++;
            endpointStats[endpoint].totalDuration += duration;
            if (isError) endpointStats[endpoint].errors++;

            const avg = (endpointStats[endpoint].totalDuration / endpointStats[endpoint].total).toFixed(2);

            sendLog({ ip, method, endpoint, status, query, duration });
            recordRequestStat(endpoint, res.statusCode);

            console.log(
                chalk[isError ? "red" : "green"](
                    `${isError ? "❌" : "✅"} [${status.toUpperCase()}] ${method} ${endpoint} | ${res.statusCode} | ${duration}ms (Avg: ${avg}ms)`
                )
            );
        });
    } catch (err) {
        console.error(chalk.red(`❌ Middleware Error: ${err.message}`));
        res.status(500).json({ status: false, message: "Internal middleware error" });
    }
});

// ========== LOAD API ROUTES ==========
let totalRoutes = 0;
const apiFolder = path.join(__dirname, "./src/api");

if (fs.existsSync(apiFolder)) {
    fs.readdirSync(apiFolder).forEach((sub) => {
        const subPath = path.join(apiFolder, sub);
        if (fs.statSync(subPath).isDirectory()) {
            fs.readdirSync(subPath).forEach((file) => {
                if (file.endsWith(".js")) {
                    const route = require(path.join(subPath, file));
                    if (typeof route === "function") route(app);

                    totalRoutes++;
                    console.log(chalk.bgYellow.black(`Loaded Route: ${file}`));
                }
            });
        }
    });
}

console.log(chalk.bgGreen.black(`Server started. Total Routes Loaded: ${totalRoutes}`));

// ========== MAIN ROUTES ==========
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "api-page", "index.html")));
app.get("/docs", (req, res) => res.sendFile(path.join(__dirname, "api-page", "docs.html")));

// ========== DEV DASHBOARD ==========
app.get("/dev/dashboard", (req, res) => {
    if (!isDevAuthorized(req)) {
        return res.status(401).sendFile(path.join(__dirname, "api-page", "dashboard-login.html"));
    }
    res.sendFile(path.join(__dirname, "api-page", "dashboard.html"));
});

app.get("/dev/api/stats", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const data = await getDashboardStats();
        const maintenance = await isMaintenanceOn();
        res.json({ status: true, redisConnected: redisEnabled, maintenance, ...data });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/maintenance", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisEnabled) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { enabled } = req.body;
        const saved = await setMaintenance(!!enabled);
        if (!saved) {
            return res.status(500).json({ status: false, error: "Gagal menyimpan status ke Redis", detail: lastRedisError });
        }
        res.json({ status: true, maintenance: !!enabled });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.get("/dev/api/keys", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const keys = await listApiKeys();
        res.json({ status: true, protected_routes: { prefixes: PROTECTED_PREFIXES, exact: PROTECTED_EXACT }, result: keys });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/keys", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisEnabled) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { label } = req.body;
        const result = await createApiKey(label);
        if (!result.key) {
            return res.status(500).json({ status: false, error: "Gagal menyimpan key ke Redis", detail: result.error });
        }
        res.json({ status: true, key: result.key });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.delete("/dev/api/keys/:key", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        await revokeApiKey(req.params.key);
        res.json({ status: true });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "api-page", "404.html")));

app.use((err, req, res, next) => {
    console.error(err.stack);
    sendNotification(`🚨 Server Error: ${err.message}`);
    res.status(500).sendFile(path.join(__dirname, "api-page", "500.html"));
});

// ========== START ==========
app.listen(PORT, () => {
    console.log(chalk.bgGreen.black(`Server running on port ${PORT}`));
});

async function redisSafeSAdd(key, member) {
    if (!redisEnabled) return false;
    try {
        await redisClient.sadd(key, member);
        return true;
    } catch {
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
    if (!redisEnabled) return;

    const isError = statusCode >= 400;
    const today = todayKey();
    const hour = hourKey();
    const endpointHourKey = `stats:ep_hourly:${endpoint}:${hour}`;

    try {
        await Promise.all([
            redisSafeIncr("stats:total:all_time"),
            redisSafeIncr(`stats:total:${today}`),
            redisSafeIncr(`stats:hourly:${hour}`),
            redisSafeHIncrBy("stats:endpoints:all_time", endpoint, 1),
            redisSafeHIncrBy(`stats:endpoints:${today}`, endpoint, 1),
            redisSafeHIncrBy(endpointHourKey, "total", 1),
            isError ? redisSafeIncr("stats:errors:all_time") : Promise.resolve(),
            isError ? redisSafeIncr(`stats:errors:${today}`) : Promise.resolve(),
            isError ? redisSafeHIncrBy("stats:errors:endpoints", endpoint, 1) : Promise.resolve(),
            isError ? redisSafeHIncrBy(endpointHourKey, "errors", 1) : Promise.resolve(),
        ]);

        redisSafeExpire(`stats:hourly:${hour}`, 60 * 60 * 48);
        redisSafeExpire(endpointHourKey, 60 * 60 * 2);

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
        const stat = await redisSafeHGetAll(endpointHourKey);
        const total = Number(stat.total) || 0;
        const errors = Number(stat.errors) || 0;
        if (errors < ALERT_MIN_ERRORS) return;
        if (errors / total < ALERT_MIN_RATE) return;

        const cooldownKey = `alert:cooldown:${endpoint}`;
        const onCooldown = await redisSafeGet(cooldownKey, null);
        if (onCooldown) return;

        await redisSafeSet(cooldownKey, "1");
        redisSafeExpire(cooldownKey, ALERT_COOLDOWN_SECONDS);

        const rate = ((errors / total) * 100).toFixed(0);
        sendWebhook(null, [
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
        redisSafeGet("stats:total:all_time", 0),
        redisSafeGet(`stats:total:${today}`, 0),
        redisSafeGet("stats:errors:all_time", 0),
        redisSafeGet(`stats:errors:${today}`, 0),
        redisSafeHGetAll("stats:endpoints:all_time"),
        redisSafeHGetAll("stats:errors:endpoints"),
    ]);

    const hourly = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
        const count = await redisSafeGet(`stats:hourly:${key}`, 0);
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

// ========== MAINTENANCE MODE ==========
const MAINTENANCE_KEY = "config:maintenance";

async function isMaintenanceOn() {
    const val = await redisSafeGet(MAINTENANCE_KEY, "off");
    return val === "on" || val === true;
}

async function setMaintenance(on) {
    return redisSafeSet(MAINTENANCE_KEY, on ? "on" : "off");
}

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
    await redisSafeSet(`apikey:${key}`, JSON.stringify(data));
    await redisSafeSAdd(API_KEYS_SET, key);
    return key;
}

async function listApiKeys() {
    const keys = await redisSafeSMembers(API_KEYS_SET);
    const result = [];
    for (const key of keys) {
        const raw = await redisSafeGet(`apikey:${key}`, null);
        if (!raw) continue;
        try {
            const data = JSON.parse(raw);
            result.push({ key, ...data });
        } catch {}
    }
    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function revokeApiKey(key) {
    await redisSafeDel(`apikey:${key}`);
    await redisSafeSRem(API_KEYS_SET, key);
}

async function validateApiKey(key) {
    if (!key) return false;
    const raw = await redisSafeGet(`apikey:${key}`, null);
    if (!raw) return false;

    try {
        const data = JSON.parse(raw);
        data.usage = (data.usage || 0) + 1;
        data.last_used = new Date().toISOString();
        redisSafeSet(`apikey:${key}`, JSON.stringify(data));
    } catch {}

    return true;
}

// ========== DISCORD WEBHOOK ==========
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function sendWebhook(content, embeds = null) {
    if (!WEBHOOK_URL) return;

    try {
        await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                embeds
                    ? { content: content || null, embeds }
                    : { content }
            )
        });
    } catch (err) {
        console.error(chalk.red(`[WebhookError] ${err.message}`));
    }
}

// ========== KIRIM NOTIF ==========
async function sendNotification(msg) {
    sendWebhook(msg);
}

// ========== KIRIM LOG API ==========
async function sendLog({ ip, method, endpoint, status, query, duration }) {
    const icons = { request: "🟡", success: "✅", error: "❌" };
    const colors = { request: 0x7289da, success: 0x57f287, error: 0xed4245 };

    const embed = [
        {
            title: `${icons[status]} API Activity - ${status.toUpperCase()}`,
            color: colors[status],
            fields: [
                { name: "IP", value: `\`${ip}\``, inline: true },
                { name: "Method", value: method, inline: true },
                { name: "Endpoint", value: endpoint },
                {
                    name: "Query",
                    value: `\`\`\`json\n${JSON.stringify(query || {}, null, 2)}\n\`\`\``
                },
                { name: "Duration", value: `${duration ?? "-"}ms`, inline: true },
                { name: "Time", value: new Date().toISOString() }
            ],
            footer: { text: "Kyzen.id Log System ✨" },
            timestamp: new Date()
        }
    ];

    sendWebhook(null, embed);
}

// ========== EXPRESS ==========
app.enable("trust proxy");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.set("json spaces", 2);

// ========== MAINTENANCE MODE CHECK ==========
app.use(async (req, res, next) => {
    // Rute /dev/* tetap bisa diakses walau maintenance nyala
    if (req.path.startsWith("/dev/") || req.path === "/health") return next();

    const isOn = await isMaintenanceOn();
    if (!isOn) return next();

    const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/download") || req.path.startsWith("/image") || req.path.startsWith("/ai") || req.path.startsWith("/anime") || req.path.startsWith("/news");

    if (wantsJson) {
        return res.status(503).json({ status: false, maintenance: true, message: "API sedang dalam perbaikan, coba lagi nanti" });
    }

    return res.status(503).sendFile(path.join(__dirname, "api-page", "maintenance.html"));
});

// ========== API KEY CHECK ==========
app.use(async (req, res, next) => {
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
});

// ========== STATIC FILES ==========
app.use("/", express.static(path.join(__dirname, "api-page")));
app.use("/src", express.static(path.join(__dirname, "src")));

// ========== LOAD OPENAPI ==========
const openApiPath = path.join(__dirname, "./src/openapi.json");
let openApi = {};

try {
    openApi = JSON.parse(fs.readFileSync(openApiPath));
} catch {
    console.warn(chalk.yellow("⚠️ openapi.json not found or invalid."));
}

// ========== /health route ==========
app.get("/health", (req, res) => {
    res.json({
        status: true,
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        redis: redisEnabled,
    });
});

// ========== /openapi.json route ==========
app.get("/openapi.json", (req, res) => {
    if (fs.existsSync(openApiPath)) res.sendFile(openApiPath);
    else res.status(404).json({ status: false, message: "openapi.json tidak ditemukan" });
});

// ========== Helper match path OpenAPI ==========
function matchOpenApiPath(requestPath) {
    const paths = Object.keys(openApi.paths || {});
    for (const apiPath of paths) {
        const regex = new RegExp("^" + apiPath.replace(/{[^}]+}/g, "[^/]+") + "$");
        if (regex.test(requestPath)) return true;
    }
    return false;
}

// ========== JSON RESPONSE WRAPPER ==========
app.use((req, res, next) => {
    const original = res.json;
    res.json = function (data) {
        if (typeof data === "object") {
            data = {
                status: data.status ?? true,
                creator: openApi.info?.author || "Kyzen.id",
                ...data
            };
        }
        return original.call(this, data);
    };
    next();
});

// ========== ENDPOINT LOGGER ==========
const endpointStats = {};

app.use(async (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const method = req.method;
    const endpoint = req.originalUrl.split("?")[0];
    const query = req.query;
    const start = Date.now();

    try {
        // REQUEST LOG
        if (matchOpenApiPath(endpoint)) {
            sendLog({ ip, method, endpoint, status: "request", query });
            console.log(chalk.yellow(`🟡 [REQUEST] ${method} ${endpoint} | IP: ${ip}`));
        }

        next();

        res.on("finish", () => {
            if (!matchOpenApiPath(endpoint)) return;

            const duration = Date.now() - start;
            const isError = res.statusCode >= 400;
            const status = isError ? "error" : "success";

            if (!endpointStats[endpoint]) endpointStats[endpoint] = { total: 0, errors: 0, totalDuration: 0 };
            endpointStats[endpoint].total++;
            endpointStats[endpoint].totalDuration += duration;
            if (isError) endpointStats[endpoint].errors++;

            const avg = (endpointStats[endpoint].totalDuration / endpointStats[endpoint].total).toFixed(2);

            sendLog({ ip, method, endpoint, status, query, duration });
            recordRequestStat(endpoint, res.statusCode);

            console.log(
                chalk[isError ? "red" : "green"](
                    `${isError ? "❌" : "✅"} [${status.toUpperCase()}] ${method} ${endpoint} | ${res.statusCode} | ${duration}ms (Avg: ${avg}ms)`
                )
            );
        });
    } catch (err) {
        console.error(chalk.red(`❌ Middleware Error: ${err.message}`));
        res.status(500).json({ status: false, message: "Internal middleware error" });
    }
});

// ========== LOAD API ROUTES ==========
let totalRoutes = 0;
const apiFolder = path.join(__dirname, "./src/api");

if (fs.existsSync(apiFolder)) {
    fs.readdirSync(apiFolder).forEach((sub) => {
        const subPath = path.join(apiFolder, sub);
        if (fs.statSync(subPath).isDirectory()) {
            fs.readdirSync(subPath).forEach((file) => {
                if (file.endsWith(".js")) {
                    const route = require(path.join(subPath, file));
                    if (typeof route === "function") route(app);

                    totalRoutes++;
                    console.log(chalk.bgYellow.black(`Loaded Route: ${file}`));
                }
            });
        }
    });
}

console.log(chalk.bgGreen.black(`Server started. Total Routes Loaded: ${totalRoutes}`));

// ========== MAIN ROUTES ==========
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "api-page", "index.html")));
app.get("/docs", (req, res) => res.sendFile(path.join(__dirname, "api-page", "docs.html")));

// ========== DEV DASHBOARD ==========
app.get("/dev/dashboard", (req, res) => {
    if (!isDevAuthorized(req)) {
        return res.status(401).sendFile(path.join(__dirname, "api-page", "dashboard-login.html"));
    }
    res.sendFile(path.join(__dirname, "api-page", "dashboard.html"));
});

app.get("/dev/api/stats", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const data = await getDashboardStats();
        const maintenance = await isMaintenanceOn();
        res.json({ status: true, redisConnected: redisEnabled, maintenance, ...data });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/maintenance", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisEnabled) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { enabled } = req.body;
        const saved = await setMaintenance(!!enabled);
        if (!saved) {
            return res.status(500).json({ status: false, error: "Gagal menyimpan status ke Redis", detail: lastRedisError });
        }
        res.json({ status: true, maintenance: !!enabled });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.get("/dev/api/keys", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const keys = await listApiKeys();
        res.json({ status: true, protected_routes: { prefixes: PROTECTED_PREFIXES, exact: PROTECTED_EXACT }, result: keys });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/keys", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisEnabled) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { label } = req.body;
        const key = await createApiKey(label);
        res.json({ status: true, key });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.delete("/dev/api/keys/:key", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        await revokeApiKey(req.params.key);
        res.json({ status: true });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "api-page", "404.html")));

app.use((err, req, res, next) => {
    console.error(err.stack);
    sendNotification(`🚨 Server Error: ${err.message}`);
    res.status(500).sendFile(path.join(__dirname, "api-page", "500.html"));
});

// ========== START ==========
app.listen(PORT, () => {
    console.log(chalk.bgGreen.black(`Server running on port ${PORT}`));
});
