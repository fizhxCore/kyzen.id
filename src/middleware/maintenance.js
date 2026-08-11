const path = require("path");
const redis = require("../utils/redis");

// ========== MAINTENANCE MODE ==========
const MAINTENANCE_KEY = "config:maintenance";

async function isMaintenanceOn() {
    const val = await redis.redisSafeGet(MAINTENANCE_KEY, "off");
    return val === "on" || val === true;
}

async function setMaintenance(on) {
    return redis.redisSafeSet(MAINTENANCE_KEY, on ? "on" : "off");
}

// ========== MAINTENANCE MODE CHECK (middleware) ==========
async function maintenanceCheckMiddleware(req, res, next) {
    // Rute /dev/* & /health tetap bisa diakses walau maintenance nyala
    if (req.path.startsWith("/dev/") || req.path === "/health") return next();

    const isOn = await isMaintenanceOn();
    if (!isOn) return next();

    const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/download") || req.path.startsWith("/image") || req.path.startsWith("/ai") || req.path.startsWith("/anime") || req.path.startsWith("/news");

    if (wantsJson) {
        return res.status(503).json({ status: false, maintenance: true, message: "API sedang dalam perbaikan, coba lagi nanti" });
    }

    return res.status(503).sendFile(path.join(__dirname, "..", "..", "api-page", "maintenance.html"));
}

module.exports = {
    isMaintenanceOn,
    setMaintenance,
    maintenanceCheckMiddleware,
};
