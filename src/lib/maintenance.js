const redis = require("./redis");

const KEY = "config:maintenance";

async function isMaintenanceOn() {
  const val = await redis.safeGet(KEY, "off");
  return val === "on" || val === true;
}

async function setMaintenance(on) {
  return redis.safeSet(KEY, on ? "on" : "off");
}

module.exports = { isMaintenanceOn, setMaintenance };
