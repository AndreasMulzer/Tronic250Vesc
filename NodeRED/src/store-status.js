const p = msg.payload || {};
const v = flow.get("vesc", "memory") || {config: {}, status: {}, telemetry: {}, memory: {}};
v.status ??= {};
v.telemetry ??= {};
if (p.control) {
    v.status.control = p.control;
} else {
    if (typeof p.available === "boolean") v.status.available = p.available;
    if (typeof p.rpm === "number" && Number.isFinite(p.rpm) && typeof p.mc_fault_code === "number") {
        for (const [key, value] of Object.entries(p)) if (value !== null && value !== undefined) v.telemetry[key] = value;
        v.status.lastRxMs = p.timestamp || Date.now();
        v.status.erpm = p.rpm;
    }
}
flow.set("vesc", v, "memory");
return msg;
