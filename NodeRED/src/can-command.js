const s = flow.get("vescCruise", "memory");
if (msg._vescSession !== undefined) {
    if (!s || msg._vescSession !== s.session || msg._vescSerial !== s.serial) return null;
    if (msg._vescCruise === true && (!s.enabled || flow.get("vesc", "memory")?.config?.engineOn !== true)) return null;
}
const x = msg.payload || {};
if (!["lisp_percent", "lisp_hard_stop"].includes(x.cmd) ||
    typeof x.percent !== "number" || !Number.isFinite(x.percent) || x.percent < -100 || x.percent > 100) return null;
const hard = x.cmd === "lisp_hard_stop";
const percent = hard ? 0 : x.percent;
const value = Math.round(percent * 10);
let data;
if (x.acquire === false) {
    data = Buffer.alloc(4);
    data[0] = 4; // Fortsetzen nur wenn WiFi die Quelle weiterhin besitzt.
    data[1] = hard ? 1 : 0;
    data.writeInt16BE(value, 2);
} else if (hard) {
    data = Buffer.from([2]);
} else {
    data = Buffer.alloc(3);
    data[0] = 1;
    data.writeInt16BE(value, 1);
}
const p = Buffer.from([34, 29, 36, ...data]);
let crc = 0;
for (const b of p) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 65535 : (crc << 1) & 65535;
}
msg.payload = Buffer.from([2, p.length, ...p, crc >> 8, crc & 255, 3]);
// Angefordert, nicht als Wirkung am Motor bestaetigt. Rueckmeldung kommt separat.
flow.set("vescLastCommand", {percent, mode: hard ? "hardStop" : "percent", timestampMs: Date.now(), source: x.source}, "memory");
node.status({fill: hard ? "red" : "green", shape: "dot", text: hard ? "Hard-STOP angefordert" : `${percent.toFixed(1)} % angefordert`});
return msg;
