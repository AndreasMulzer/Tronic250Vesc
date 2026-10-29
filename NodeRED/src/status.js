// Actual motor motion comes from GET_VALUES; control ownership and applied mode
// come ONLY from the VESC LispBM feedback. A sent WiFi command proves neither.
const nowMs = Date.now(), timestamp = new Date(nowMs).toISOString();
const BASE = "propulsion.torqeedo", ERPM_FACTOR = 7, GEAR_RATIO = 14;
const TELEMETRY_MAX_AGE_MS = 2000, FEEDBACK_MAX_AGE_MS = 1500, STOP_ERPM = 100;
const numeric = n => typeof n === "number" && Number.isFinite(n);
const object = o => o && typeof o === "object" && !Array.isArray(o);
const fresh = (stamp, age) => numeric(stamp) && nowMs >= stamp && nowMs - stamp <= age;
let v = flow.get("vesc", "memory");
if (!object(v)) v = {};
v.status ??= {}; v.telemetry ??= {}; v.memory ??= {};
const t = v.telemetry, control = v.status.control;
const available = fresh(v.status.lastRxMs, TELEMETRY_MAX_AGE_MS);
const feedbackAvailable = object(control) && control.protocolVersion === 1 &&
    (control.source === 0 || control.source === 1) &&
    (control.mode === 0 || control.mode === 1) &&
    numeric(control.percent) && control.percent >= -100 && control.percent <= 100 &&
    fresh(control.lastRxMs, FEEDBACK_MAX_AGE_MS);
const activeSource = feedbackAvailable ? (control.source === 0 ? "poti" : "wifi") : "unknown";
const appliedMode = !feedbackAvailable ? "unknown" : control.mode === 1 ? "hardStop" :
    control.percent > 0 ? "forward" : control.percent < 0 ? "reverse" : "stop";
const lastCommand = flow.get("vescLastCommand", "memory");
const commandValid = object(lastCommand) && numeric(lastCommand.timestampMs) &&
    lastCommand.timestampMs >= 0 && lastCommand.timestampMs <= nowMs && (lastCommand.mode === "hardStop" ||
    (lastCommand.mode === "percent" && numeric(lastCommand.percent) &&
     lastCommand.percent >= -100 && lastCommand.percent <= 100));
const requestedMode = !commandValid ? "unknown" : lastCommand.mode === "hardStop" ? "hardStop" :
    lastCommand.percent > 0 ? "forward" : lastCommand.percent < 0 ? "reverse" : "stop";
const hasFaultCode = available && numeric(t.mc_fault_code);
const fault = hasFaultCode && t.mc_fault_code !== 0;
const hasRpm = available && numeric(t.rpm);
const driveState = !available ? "unknown" : fault ? "fault" : !hasRpm ? "unknown" :
    t.rpm > STOP_ERPM ? "forward" : t.rpm < -STOP_ERPM ? "reverse" : "stopped";
const stateNames = {forward: "Motor dreht vorwärts", reverse: "Motor dreht rückwärts",
    stopped: "Motor steht", fault: "VESC-Fehler", unknown: "Motorzustand unbekannt"};
const modeNames = {forward: "Vorwärts", reverse: "Rückwärts", stop: "0-%-Sollwert",
    hardStop: "Harter STOP aktiv", unknown: "Steuerzustand unbekannt"};
const sourceNames = {poti: "Potentiometer", wifi: "Steuerung (WiFi)", unknown: "unbekannt"};
function faultText(code) {
    const names = ["none", "over_voltage", "under_voltage", "drv", "abs_over_current",
        "over_temp_fet", "over_temp_motor", "gate_driver_over_voltage", "gate_driver_under_voltage",
        "mcu_under_voltage", "watchdog_reset", "encoder_spi", "encoder_sincos_below_min_amplitude",
        "encoder_sincos_above_max_amplitude", "flash_corruption", "high_offset_current_sensor_1",
        "high_offset_current_sensor_2", "high_offset_current_sensor_3", "unbalanced_currents",
        "resolver_lot", "resolver_dos", "resolver_los"];
    return names[code] || `unknown_${code}`;
}
let controlStatus = `${modeNames[appliedMode]} | ${stateNames[driveState]} | Steuerquelle: ${sourceNames[activeSource]}`;
if (!available) controlStatus += " | VESC-Telemetrie fehlt/veraltet";
if (!feedbackAvailable) controlStatus += " | VESC-Steuerrückmeldung fehlt/veraltet";
if (fault) controlStatus += ` (${faultText(t.mc_fault_code)})`;

const values = [], meta = [];
function remember(path, value) {
    const parts = path.split(".");
    let target = v.memory;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!object(target[parts[i]])) target[parts[i]] = {};
        target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
}
function add(suffix, value, allowNull = false) {
    if (value === undefined || (value === null && !allowNull) ||
        (typeof value === "number" && !Number.isFinite(value))) return;
    const path = `${BASE}.${suffix}`;
    values.push({path, value});
    remember(path, value);
}
function metadata(suffix, displayName, units, description) {
    const value = {displayName};
    if (units) value.units = units;
    if (description) value.description = description;
    meta.push({path: `${BASE}.${suffix}`, value});
}
add("drive.label", "Torqeedo");
add("drive.available", available);
add("controller.available", available);
add("drive.state", driveState);
add("drive.type", "pod");
add("drive.fuel.type", "electric");
add("drive.transmission.gearRatioText", "14:1");
// Standard Signal K enums; null invalidates a prior value after feedback loss.
add("state", driveState === "fault" ? "unusable" : driveState === "stopped" ? "stopped" :
    driveState === "forward" || driveState === "reverse" ? "started" : null, true);
add("transmission.gear", fault ? "Fault" : !feedbackAvailable ? null :
    appliedMode === "forward" ? "Forward" : appliedMode === "reverse" ? "Reverse" : "Neutral", true);
add("controller.feedbackAvailable", feedbackAvailable);
add("controller.activeSource", activeSource);
add("controller.activeMode", appliedMode);
add("controller.hardStopActive", feedbackAvailable ? control.mode === 1 : null, true);
add("controller.appliedPercent", feedbackAvailable ? control.percent / 100 : null, true);
add("controller.command", requestedMode);
add("controller.commandSource", commandValid && ["manual", "cruise"].includes(lastCommand.source) ? lastCommand.source : "unknown");
add("controller.commandPercent", commandValid ? (lastCommand.mode === "hardStop" ? 0 : lastCommand.percent / 100) : null, true);
add("controller.lastCommandTime", commandValid ? new Date(lastCommand.timestampMs).toISOString() : null, true);
add("controller.controlStatus", controlStatus);
if (available) {
    if (hasRpm) {
        add("drive.revolutions", t.rpm / ERPM_FACTOR / GEAR_RATIO / 60);
        add("drive.motorRpm", t.rpm / ERPM_FACTOR);
        add("drive.propellerRpm", t.rpm / ERPM_FACTOR / GEAR_RATIO);
    }
    if (numeric(t.temp_motor)) add("drive.temperature", t.temp_motor + 273.15);
    if (numeric(t.temp_fet)) add("controller.temperature", t.temp_fet + 273.15);
    if (numeric(t.avg_motor_current)) add("controller.current", t.avg_motor_current);
    if (numeric(t.avg_input_current)) add("controller.inputCurrent", t.avg_input_current);
    if (numeric(t.duty_cycle_now)) add("controller.dutyCycle", t.duty_cycle_now);
    if (numeric(t.v_in)) add("controller.inputVoltage", t.v_in);
    if (numeric(t.v_in) && numeric(t.avg_input_current)) {
        add("drive.power", t.v_in * t.avg_input_current);
        add("controller.inputPower", t.v_in * t.avg_input_current);
    }
    if (hasFaultCode) {
        add("controller.faultCode", faultText(t.mc_fault_code));
        add("controller.faultCodeNumber", t.mc_fault_code);
    }
}
const cruise = flow.get("vescCruise", "memory");
if (object(cruise)) {
    add("controller.cruise.enabled", cruise.enabled === true);
    add("controller.cruise.targetSpeed", numeric(cruise.targetKn) ? cruise.targetKn * 1852 / 3600 : undefined);
    const sogFresh = fresh(cruise.sogTimestampMs, 3000) && fresh(cruise.sogReceivedMs, 3000);
    add("controller.cruise.sog", sogFresh && numeric(cruise.sogKn) ? cruise.sogKn * 1852 / 3600 : null, true);
    add("controller.cruise.sogFiltered", sogFresh && numeric(cruise.filteredKn) ? cruise.filteredKn * 1852 / 3600 : null, true);
    add("controller.cruise.sogWindowSize", numeric(cruise.sogWindowSize) ? cruise.sogWindowSize : undefined);
    add("controller.cruise.sogSampleCount", sogFresh && Array.isArray(cruise.sogSamplesKn) ? cruise.sogSamplesKn.length : 0);
    for (const [suffix, key] of [["output", "outputPercent"], ["p", "pTerm"], ["i", "integral"], ["d", "dTerm"]])
        add(`controller.cruise.${suffix}`, numeric(cruise[key]) ? cruise[key] / 100 : undefined);
    add("controller.cruise.reason", typeof cruise.reason === "string" ? cruise.reason : undefined);
}
for (const [path, label, units] of [
    ["drive.available", "Motor-Telemetrie verfügbar"], ["drive.state", "Gemessener Motorzustand"],
    ["drive.revolutions", "Propellerdrehzahl", "Hz"], ["drive.motorRpm", "Motordrehzahl", "rpm"],
    ["drive.propellerRpm", "Propellerdrehzahl", "rpm"], ["drive.temperature", "Motortemperatur", "K"],
    ["drive.power", "Motor-Eingangsleistung", "W"], ["controller.temperature", "Reglertemperatur", "K"],
    ["controller.current", "Motorstrom", "A"], ["controller.inputCurrent", "Batteriestrom", "A"],
    ["controller.inputPower", "Regler-Eingangsleistung", "W"], ["controller.inputVoltage", "Batteriespannung", "V"],
    ["controller.dutyCycle", "Tastverhältnis", "ratio"], ["controller.faultCode", "VESC-Fehler"],
    ["controller.feedbackAvailable", "Steuerrückmeldung verfügbar"], ["controller.activeSource", "Aktive Steuerquelle"],
    ["controller.activeMode", "Vom VESC angewendeter Modus"], ["controller.hardStopActive", "Harter STOP aktiv"],
    ["controller.appliedPercent", "Vom VESC angewendeter Drehzahlsollwert", "ratio"],
    ["controller.command", "Zuletzt gesendeter Steuerbefehl"], ["controller.commandSource", "Quelle des letzten Steuerbefehls"],
    ["controller.commandPercent", "Zuletzt gesendeter Drehzahlsollwert", "ratio"],
    ["controller.lastCommandTime", "Zeit des letzten Steuerbefehls"], ["controller.controlStatus", "Antriebsstatus"],
    ["controller.cruise.enabled", "Tempomat eingeschaltet"], ["controller.cruise.targetSpeed", "Tempomat-Sollgeschwindigkeit", "m/s"],
    ["controller.cruise.sog", "Tempomat-SOG roh", "m/s"],
    ["controller.cruise.sogFiltered", "Tempomat-SOG Mittelwert", "m/s"],
    ["controller.cruise.sogWindowSize", "SOG-Mittelwert Fenstergröße"],
    ["controller.cruise.sogSampleCount", "SOG-Mittelwert gültige Messwerte"],
    ["controller.cruise.output", "Tempomat-Ausgang", "ratio"],
    ["controller.cruise.p", "PID-P-Anteil", "ratio"], ["controller.cruise.i", "PID-I-Anteil", "ratio"],
    ["controller.cruise.d", "PID-D-Anteil", "ratio"], ["controller.cruise.reason", "Tempomat-Status"]
]) metadata(path, label, units);

const wasFull = context.get("fullSent") === true;
const previous = context.get("lastSent") || {}, changed = [];
for (const item of values) {
    const encoded = JSON.stringify(item.value);
    if (!wasFull || previous[item.path] !== encoded) changed.push(item);
    previous[item.path] = encoded;
}
const lastHeartbeatMs = context.get("lastHeartbeatMs");
const heartbeat = !wasFull || !numeric(lastHeartbeatMs) || nowMs < lastHeartbeatMs || nowMs - lastHeartbeatMs >= 1000;
flow.set("vesc", v, "memory");
if (wasFull && !changed.length && !heartbeat) return null;
context.set("fullSent", true);
context.set("lastSent", previous);
if (heartbeat) context.set("lastHeartbeatMs", nowMs);
const source = {label: "vesc", type: "VESC"};
msg.payload = {context: "vessels.self", updates: [
    {source, timestamp, values: heartbeat ? values : changed},
    ...(!wasFull ? [{source, timestamp, meta}] : [])
]};
return msg;
