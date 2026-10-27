const now = Date.now();
let rx = context.get("rx") || Buffer.alloc(0);
let lastTelemetry = context.get("lastTelemetry") || 0;
if (msg.topic === "watchdog") return {payload: {available: lastTelemetry > 0 && now - lastTelemetry <= 2000, timestamp: now}};
if (!Buffer.isBuffer(msg.payload)) {
    if (!Array.isArray(msg.payload)) return null;
    msg.payload = Buffer.from(msg.payload);
}
rx = Buffer.concat([rx, msg.payload]);
if (rx.length > 8192) rx = rx.subarray(rx.length - 8192);
function crc16(p) {
    let crc = 0;
    for (const b of p) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 65535 : (crc << 1) & 65535;
    }
    return crc;
}
function parse(p) {
    if (p[0] === 34) return p.length >= 3 && p[1] === 29 ? parse(p.subarray(2)) : null;
    if (p[0] === 36) {
        if (p.length !== 7 || p[1] !== 129 || p[2] !== 1 || p[3] > 1 || p[4] > 1) return null;
        const value = p.readInt16BE(5);
        if (value < -1000 || value > 1000 || (p[4] === 1 && (p[3] !== 1 || value !== 0))) return null;
        return {control: {protocolVersion: 1, source: p[3], mode: p[4], percent: value / 10, lastRxMs: now}};
    }
    // GET_VALUES: vollstaendig bis Fault-Code; Teilantworten sind kein Lebenszeichen.
    if (p[0] !== 4 || p.length < 54) return null;
    let i = 1;
    const q = scale => {const x = p.readInt16BE(i) / scale; i += 2; return x;};
    const w = scale => {const x = p.readInt32BE(i) / scale; i += 4; return x;};
    const data = {available: true, temp_fet: q(10), temp_motor: q(10),
        avg_motor_current: w(100), avg_input_current: w(100), avg_id: w(100), avg_iq: w(100),
        duty_cycle_now: q(1000), rpm: w(1), v_in: q(10),
        amp_hours: w(10000), amp_hours_charged: w(10000), watt_hours: w(10000), watt_hours_charged: w(10000),
        tachometer: w(1), tachometer_abs: w(1), mc_fault_code: p.readUInt8(i), timestamp: now};
    lastTelemetry = now;
    context.set("lastTelemetry", now);
    return data;
}
const out = [];
while (rx.length >= 5) {
    const start = rx.indexOf(2);
    if (start < 0) {rx = Buffer.alloc(0); break;}
    if (start > 0) rx = rx.subarray(start);
    if (rx.length < 5) break;
    const size = rx[1];
    const total = size + 5;
    if (rx.length < total) break;
    const p = rx.subarray(2, size + 2);
    if (rx[total - 1] !== 3 || crc16(p) !== ((rx[total - 3] << 8) | rx[total - 2])) {
        rx = rx.subarray(1); // Bei CRC-Fehlern nicht den naechsten Rahmen verwerfen.
        continue;
    }
    const data = parse(p);
    if (data) out.push({topic: data.control ? "vesc_control_feedback" : "vesc_telemetry", payload: data});
    rx = rx.subarray(total);
}
context.set("rx", rx);
return out.length ? [out] : null;
