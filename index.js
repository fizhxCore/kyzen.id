const express = require("express");
const chalk = require("chalk");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const stats = require("./src/lib/stats");
const maintenanceLib = require("./src/lib/maintenance");

const app = express();
const PORT = process.env.PORT || 4000;
const DEV_SECRET = process.env.DEV_SECRET || "";

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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.set("json spaces", 2);

// ========== STATIC FILES ==========
app.use("/", express.static(path.join(__dirname, "api-page")));
app.use("/src", express.static(path.join(__dirname, "src")));

// ========== MAINTENANCE MODE CHECK ==========
function isDevAuthorized(req) {
    if (!DEV_SECRET) return false;
    const key = req.headers["x-dev-key"] || req.query.key;
    return key === DEV_SECRET;
}

app.use(async (req, res, next) => {
    // Rute /dev/* & dashboard sendiri tetap bisa diakses walau maintenance nyala
    if (req.path.startsWith("/dev/")) return next();

    const isOn = await maintenanceLib.isMaintenanceOn();
    if (!isOn) return next();

    const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/download") || req.path.startsWith("/image") || req.path.startsWith("/ai") || req.path.startsWith("/anime") || req.path.startsWith("/news");

    if (wantsJson) {
        return res.status(503).json({ status: false, maintenance: true, message: "API sedang dalam perbaikan, coba lagi nanti" });
    }

    return res.status(503).sendFile(path.join(__dirname, "api-page", "maintenance.html"));
});

// ========== LOAD OPENAPI ==========
const openApiPath = path.join(__dirname, "./src/openapi.json");
let openApi = {};

try {
    openApi = JSON.parse(fs.readFileSync(openApiPath));
} catch {
    console.warn(chalk.yellow("⚠️ openapi.json not found or invalid."));
}

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
            stats.recordRequest(endpoint, res.statusCode);

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
                    sendNotification(`✅ Loaded Route: ${file}`);
                }
            });
        }
    });
}

sendNotification(`🟢 Server started. Total Routes Loaded: ${totalRoutes}`);

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
        const data = await stats.getStats();
        const maintenance = await maintenanceLib.isMaintenanceOn();
        res.json({ status: true, maintenance, ...data });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

app.post("/dev/api/maintenance", async (req, res) => {
    if (!isDevAuthorized(req)) return res.status(401).json({ status: false, error: "Unauthorized" });
    try {
        const { enabled } = req.body;
        await maintenanceLib.setMaintenance(!!enabled);
        res.json({ status: true, maintenance: !!enabled });
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
