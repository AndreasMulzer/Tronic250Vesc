if (msg.topic !== "engine_on" || typeof msg.payload !== "boolean") return null;
const v = flow.get("vesc", "memory") || {};
v.config = {engineOn: msg.payload};
if (!msg.payload) {
    const s = flow.get("vescCruise", "memory");
    if (s) {
        s.enabled = false;
        s.serial += 1;
        s.integral = 0;
        s.reason = "Motor ausgeschaltet";
        flow.set("vescCruise", s, "memory");
    }
}
flow.set("vesc", v, "memory");
flow.set("vesc", {config: v.config}, "file");
return msg;
