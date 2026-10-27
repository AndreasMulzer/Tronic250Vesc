const s = flow.get("vescCruise", "memory");
if (msg._vescSession !== undefined) {
    if (!s || msg._vescSession !== s.session || msg._vescSerial !== s.serial) return null;
    if (msg._vescCruise === true && (!s.enabled || flow.get("vesc", "memory")?.config?.engineOn !== true)) return null;
}
const p = msg.payload;
if (typeof p !== "number" || !Number.isFinite(p) || p < -100 || p > 100) {
    node.error("Ungueltiger Drehzahlsollwert", msg);
    return null;
}
msg.payload = {
    cmd: msg._vescHardStop === true ? "lisp_hard_stop" : "lisp_percent",
    percent: msg._vescHardStop === true ? 0 : p,
    acquire: msg._vescAcquire !== false,
    source: msg._vescCruise === true ? "cruise" : "manual"
};
return msg;
