"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/../NodeRED/src/status.js", "utf8");
const BASE = "propulsion.torqeedo.";
let passed = 0;
function test(name, body) { body(); passed++; console.log(`OK ${name}`); }
function harness() {
    const state = {now: 100000, flow: {}, context: {}};
    class Clock extends Date { static now() { return state.now; } }
    const execute = new vm.Script(`(function () { ${source}\n})()`);
    const sandbox = vm.createContext({Date: Clock, msg: {},
        flow: {get: key => state.flow[key], set: (key, value) => {state.flow[key] = value;}},
        context: {get: key => state.context[key], set: (key, value) => {state.context[key] = value;}}});
    state.run = payload => {
        sandbox.msg = {payload: payload || {}};
        const result = execute.runInContext(sandbox);
        if (!result) return null;
        const plain = JSON.parse(JSON.stringify(result));
        plain.values = Object.fromEntries(plain.payload.updates.flatMap(update => update.values || [])
            .map(({path, value}) => [path.slice(BASE.length), value]));
        return plain;
    };
    state.vesc = (overrides = {}) => {
        state.flow.vesc = {status: {lastRxMs: state.now,
            control: {source: 1, mode: 0, percent: 30, lastRxMs: state.now, protocolVersion: 1}},
            telemetry: {rpm: 5880, mc_fault_code: 0, v_in: 50, avg_input_current: 2,
                avg_motor_current: 4, temp_motor: 30, temp_fet: 40, duty_cycle_now: 0.25}, memory: {}};
        for (const [key, value] of Object.entries(overrides)) state.flow.vesc[key] = value;
        return state.flow.vesc;
    };
    return state;
}
test("No feedback never invents stopped or WiFi ownership", () => {
    const h = harness(), v = h.run().values;
    assert.equal(v["drive.state"], "unknown");
    assert.equal(v["controller.activeSource"], "unknown");
    assert.equal(v["controller.activeMode"], "unknown");
    assert.equal(v["drive.available"], false);
    assert.equal(v["controller.hardStopActive"], null);
    assert.equal(v.state, null);
    assert.equal(v["transmission.gear"], null);
});
test("Poti is actual owner even after Node-RED sends reverse", () => {
    const h = harness(), x = h.vesc(); x.status.control.source = 0;
    h.flow.vescLastCommand = {percent: -70, mode: "percent", timestampMs: h.now, source: "manual"};
    const v = h.run().values;
    assert.equal(v["controller.activeSource"], "poti");
    assert.equal(v["controller.command"], "reverse");
    assert.equal(v["controller.activeMode"], "forward");
    assert.equal(v["drive.state"], "forward");
    assert.match(v["controller.controlStatus"], /Potentiometer/);
});
test("Requested and applied reverse do not rewrite measured forward rotation", () => {
    const h = harness(), x = h.vesc(); x.status.control.percent = -50;
    const v = h.run().values;
    assert.equal(v["controller.activeMode"], "reverse");
    assert.equal(v["transmission.gear"], "Reverse");
    assert.equal(v["drive.state"], "forward");
    assert.equal(v.state, "started");
});
test("Hard STOP while moving reports active braking and actual motion separately", () => {
    const h = harness(), x = h.vesc(); x.status.control.mode = 1; x.status.control.percent = 0;
    const v = h.run().values;
    assert.equal(v["controller.activeMode"], "hardStop");
    assert.equal(v["controller.hardStopActive"], true);
    assert.equal(v["drive.state"], "forward");
    assert.equal(v["transmission.gear"], "Neutral");
    assert.match(v["controller.controlStatus"], /Harter STOP aktiv.*Motor dreht vorwärts/);
});
test("Sent hard STOP without applied ACK never claims hard STOP active", () => {
    const h = harness(); h.vesc();
    h.flow.vescLastCommand = {percent: 0, mode: "hardStop", timestampMs: h.now, source: "manual"};
    const v = h.run().values;
    assert.equal(v["controller.command"], "hardStop");
    assert.equal(v["controller.activeMode"], "forward");
    assert.equal(v["controller.hardStopActive"], false);
});
test("Zero RPM command does not claim a moving motor has stopped", () => {
    const h = harness(), x = h.vesc(); x.status.control.percent = 0;
    const v = h.run().values;
    assert.equal(v["controller.activeMode"], "stop");
    assert.equal(v["drive.state"], "forward");
    assert.equal(v["controller.hardStopActive"], false);
});
test("Negative current has no removed regenerative-state inference", () => {
    const h = harness(), x = h.vesc(); x.telemetry.avg_input_current = -5;
    const v = h.run().values;
    assert.equal(v["drive.state"], "forward");
    assert.equal(v["drive.power"], -250);
    assert.equal(v["controller.inputPower"], -250);
    assert.equal(v["controller.driveMode"], undefined);
});
test("Motor/gear conversion retains 7 pole pairs, 14:1 reduction and SI", () => {
    const h = harness(); h.vesc(); const v = h.run().values;
    assert.equal(v["drive.revolutions"], 1);
    assert.equal(v["drive.motorRpm"], 840);
    assert.equal(v["drive.propellerRpm"], 60);
    assert.equal(v["drive.temperature"], 303.15);
    assert.equal(v["controller.temperature"], 313.15);
    assert.equal(v["drive.power"], 100);
});
test("Both 100 ERPM deadband boundaries count as stopped", () => {
    for (const rpm of [-100, 0, 100]) {
        const h = harness(), x = h.vesc(); x.telemetry.rpm = rpm;
        const v = h.run().values;
        assert.equal(v["drive.state"], "stopped");
        assert.equal(v.state, "stopped");
    }
});
test("Rotation beyond the negative deadband is measured reverse", () => {
    const h = harness(), x = h.vesc(); x.telemetry.rpm = -101;
    assert.equal(h.run().values["drive.state"], "reverse");
});
test("Fresh VESC fault overrides movement state", () => {
    const h = harness(), x = h.vesc(); x.telemetry.mc_fault_code = 5;
    const v = h.run().values;
    assert.equal(v["drive.state"], "fault");
    assert.equal(v.state, "unusable");
    assert.equal(v["transmission.gear"], "Fault");
    assert.match(v["controller.controlStatus"], /over_temp_fet/);
});
test("Telemetry and control feedback use independent exact freshness limits", () => {
    const h = harness(), x = h.vesc();
    x.status.lastRxMs -= 2000; x.status.control.lastRxMs -= 1500;
    const v = h.run().values;
    assert.equal(v["drive.available"], true);
    assert.equal(v["controller.feedbackAvailable"], true);
});
test("Aged control clears ownership and applied mode while telemetry stays available", () => {
    const h = harness(), x = h.vesc(); x.status.control.lastRxMs -= 1501;
    const v = h.run().values;
    assert.equal(v["drive.available"], true);
    assert.equal(v["drive.state"], "forward");
    assert.equal(v["controller.activeSource"], "unknown");
    assert.equal(v["controller.hardStopActive"], null);
    assert.equal(v["transmission.gear"], null);
});
test("Fresh custom feedback cannot keep old motor telemetry available", () => {
    const h = harness(), x = h.vesc(); x.status.lastRxMs -= 2001;
    const v = h.run({available: true}).values;
    assert.equal(v["controller.activeSource"], "wifi");
    assert.equal(v["drive.available"], false);
    assert.equal(v["drive.state"], "unknown");
    assert.equal(v.state, null);
    assert.equal(v["drive.revolutions"], undefined);
});
test("Malformed feedback does not grant ownership", () => {
    for (const invalid of [{source: 2}, {mode: 2}, {percent: 101}, {percent: NaN},
        {protocolVersion: 2}, {protocolVersion: undefined}, {lastRxMs: 100001}]) {
        const h = harness(), x = h.vesc(); Object.assign(x.status.control, invalid);
        const v = h.run().values;
        assert.equal(v["controller.feedbackAvailable"], false);
        assert.equal(v["controller.activeSource"], "unknown");
    }
});
test("Unchanged status is suppressed before one second", () => {
    const h = harness(); h.vesc(); h.run(); h.now += 500;
    assert.equal(h.run(), null);
});
test("Heartbeat refreshes unchanged source and motor timestamps each second", () => {
    const h = harness(); h.vesc(); h.run(); h.now += 1000;
    const result = h.run();
    assert.equal(result.values["controller.activeSource"], "wifi");
    assert.equal(result.values["drive.state"], "forward");
    assert.equal(result.payload.updates[0].timestamp, new Date(h.now).toISOString());
    assert.equal(result.payload.updates.length, 1);
});
test("Frequent current changes cannot postpone the one-second full heartbeat", () => {
    const h = harness(), x = h.vesc(); h.run();
    for (let i = 1; i <= 5; i++) {
        h.now += 200; x.telemetry.avg_input_current++;
        const result = h.run();
        if (i < 5) assert.equal(result.values["controller.activeSource"], undefined);
        else assert.equal(result.values["controller.activeSource"], "wifi");
    }
});
test("Watchdog transition clears previous state rather than reporting stopped", () => {
    const h = harness(); h.vesc(); h.run(); h.now += 2100;
    const v = h.run({available: false}).values;
    assert.equal(v["drive.available"], false);
    assert.equal(v["drive.state"], "unknown");
    assert.equal(v["controller.activeSource"], "unknown");
    assert.equal(v.state, null);
    assert.equal(v["transmission.gear"], null);
    assert.equal(h.flow.vesc.memory.propulsion.torqeedo.drive.state, "unknown");
});
test("Cruise status converts kn to m/s and percent to ratio", () => {
    const h = harness(); h.vesc(); h.flow.vescCruise = {enabled: true,
        targetKn: 2, sogKn: 1, sogTimestampMs: h.now, sogReceivedMs: h.now,
        pTerm: 80, integral: 10, dTerm: -5, outputPercent: 85, reason: "PID aktiv"};
    const v = h.run().values;
    assert.equal(v["controller.cruise.enabled"], true);
    assert.equal(v["controller.cruise.targetSpeed"], 2 * 1852 / 3600);
    assert.equal(v["controller.cruise.sog"], 1852 / 3600);
    assert.equal(v["controller.cruise.p"], 0.8);
    assert.equal(v["controller.cruise.d"], -0.05);
    assert.equal(v["controller.cruise.output"], 0.85);
});
test("Cruise SOG is invalidated when old", () => {
    const h = harness(); h.vesc(); h.flow.vescCruise = {sogKn: 1,
        sogTimestampMs: h.now - 3001, sogReceivedMs: h.now};
    assert.equal(h.run().values["controller.cruise.sog"], null);
});
test("Metadata advertises standard physical units and ratio commands", () => {
    const h = harness(); h.vesc(); const output = h.run();
    const meta = Object.fromEntries(output.payload.updates.flatMap(update => update.meta || [])
        .map(({path, value}) => [path.slice(BASE.length), value]));
    assert.equal(meta["controller.commandPercent"].units, "ratio");
    assert.equal(meta["controller.cruise.targetSpeed"].units, "m/s");
    assert.equal(meta["drive.revolutions"].units, "Hz");
    assert.equal(meta["controller.temperature"].units, "K");
});
test("No malformed number is emitted as telemetry", () => {
    const h = harness(), x = h.vesc();
    x.telemetry.temp_motor = NaN; x.telemetry.avg_input_current = Infinity;
    const v = h.run().values;
    assert.equal(v["drive.temperature"], undefined);
    assert.equal(v["drive.power"], undefined);
});
test("Old last-command layout never claims an applied control state", () => {
    const h = harness(); h.flow.vescLastCommand = {percent: 80, timestampMs: h.now};
    const v = h.run().values;
    assert.equal(v["controller.command"], "unknown");
    assert.equal(v["controller.commandPercent"], null);
    assert.equal(v["controller.activeSource"], "unknown");
});
console.log(`${passed} status tests passed`);
