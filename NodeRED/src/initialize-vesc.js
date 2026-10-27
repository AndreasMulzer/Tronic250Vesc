const previous = flow.get("vesc", "memory") || {};
const saved = flow.get("vesc", "file");
const engineOn = typeof saved?.config?.engineOn === "boolean"
    ? saved.config.engineOn : previous.config?.engineOn === true;
const status = previous.status || {};
for (const key of ["driveMode", "recuperateAutoAllowed", "recuperateEffective", "recuperateReason", "batterySoc", "batteryAgeMs"])
    delete status[key];
delete status.control;
const v = {config: {engineOn}, status: {...status, available: false, lastRxMs: 0, erpm: 0},
    telemetry: previous.telemetry || {}, memory: previous.memory || {}};
flow.set("vesc", v, "memory");
flow.set("vesc", {config: v.config}, "file");
return {topic: "engine_on", payload: engineOn};
