const express = require("express");
const helmet = require("helmet");
const chalk = require("chalk");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const redisUtil = require("./src/utils/redis");
const statsUtil = require("./src/utils/stats");
const logger = require("./src/utils/logger");
const maintenanceMw = require("./src/middleware/maintenance");
const authMw = require("./src/middleware/auth");

const app = express();
const PORT = process.env.PORT || 4000;

// ========== EXPRESS ==========
app.enable("trust proxy");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.set("json spaces", 2);

// ========== MAINTENANCE MODE CHECK ==========
app.use(maintenanceMw.maintenanceCheckMiddleware);

// ========== API KEY CHECK ==========
app.use(authMw.apiKeyCheckMiddleware);

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
        redis: redisUtil.isRedisEnabled(),
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
            logger.sendLog({ ip, method, endpoint, status: "request", query });
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

            logger.sendLog({ ip, method, endpoint, status, query, duration });
            statsUtil.recordRequestStat(endpoint, res.statusCode);

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
let failedRoutes = 0;
const apiFolder = path.join(__dirname, "./src/api");

if (fs.existsSync(apiFolder)) {
    fs.readdirSync(apiFolder).forEach((sub) => {
        const subPath = path.join(apiFolder, sub);
        if (fs.statSync(subPath).isDirectory()) {
            fs.readdirSync(subPath).forEach((file) => {
                if (file.endsWith(".js")) {
                    try {
                        const route = require(path.join(subPath, file));
                        if (typeof route === "function") route(app);

                        totalRoutes++;
                        console.log(chalk.bgYellow.black(`Loaded Route: ${file}`));
                    } catch (err) {
                        failedRoutes++;
                        console.error(chalk.bgRed.white(`[ROUTE ERROR] ${sub}/${file}`));
                        console.error(chalk.red(`Reason: ${err.message}`));
                    }
                }
            });
        }
    });
}

if (failedRoutes > 0) {
    logger.sendNotification(`⚠️ ${failedRoutes} route gagal di-load saat startup. Cek Vercel Function Logs buat detail.`);
}

console.log(chalk.bgGreen.black(`Server started. Total Routes Loaded: ${totalRoutes}`));

// ========== MAIN ROUTES ==========
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "api-page", "index.html")));
app.get("/docs", (req, res) => res.sendFile(path.join(__dirname, "api-page", "docs.html")));

// ========== DEV DASHBOARD ==========
app.get("/dev/dashboard", (req, res) => {
    if (!authMw.isDevAuthorized(req)) {
        return res.status(401).sendFile(path.join(__dirname, "api-page", "dashboard-login.html"));
    }
    res.sendFile(path.join(__dirname, "api-page", "dashboard.html"));
});

app.get("/dev/api/stats", async (req, res) => {
    if (!authMw.isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const data = await statsUtil.getDashboardStats();
        const maintenance = await maintenanceMw.isMaintenanceOn();
        res.json({ status: true, redisConnected: redisUtil.isRedisEnabled(), maintenance, ...data });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/maintenance", async (req, res) => {
    if (!authMw.isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisUtil.isRedisEnabled()) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { enabled } = req.body;
        const saved = await maintenanceMw.setMaintenance(!!enabled);
        if (!saved) {
            return res.status(500).json({ status: false, error: "Gagal menyimpan status ke Redis", detail: redisUtil.getLastRedisError() });
        }
        res.json({ status: true, maintenance: !!enabled });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.get("/dev/api/keys", async (req, res) => {
    if (!authMw.isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const keys = await authMw.listApiKeys();
        res.json({ status: true, protected_routes: { prefixes: authMw.PROTECTED_PREFIXES, exact: authMw.PROTECTED_EXACT }, result: keys });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/keys", async (req, res) => {
    if (!authMw.isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    if (!redisUtil.isRedisEnabled()) {
        return res.status(503).json({ status: false, error: "Redis belum terhubung. Cek env var UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN." });
    }
    try {
        const { label } = req.body;
        const result = await authMw.createApiKey(label);
        if (!result.key) {
            return res.status(500).json({ status: false, error: "Gagal menyimpan key ke Redis", detail: result.error });
        }
        res.json({ status: true, key: result.key });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.delete("/dev/api/keys/:key", async (req, res) => {
    if (!authMw.isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        await authMw.revokeApiKey(req.params.key);
        res.json({ status: true });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "api-page", "404.html")));

app.use((err, req, res, next) => {
    console.error(err.stack);
    logger.sendNotification(`🚨 Server Error: ${err.message}`);
    res.status(500).sendFile(path.join(__dirname, "api-page", "500.html"));
});

// ========== START ==========
app.listen(PORT, () => {
    console.log(chalk.bgGreen.black(`Server running on port ${PORT}`));
});
