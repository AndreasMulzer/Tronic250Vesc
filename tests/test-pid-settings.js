'use strict';
// Exercise the actual shipped Function nodes with a simulated clock and stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, '../NodeRED/flow.json'), 'utf8'));
const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
const CONTROL = '6d560d867c410001';
const BUILD = '3d6d755ef82aefb8';
const CAN = '68e1f123023253f2';
const EPOCH = Date.parse('2026-10-29T10:00:00.000Z');
const DEFAULT_PID = {kp: 100, ki: 5, kd: 10};
let passed = 0, failed = 0;

function test(name, fn) {
    try { fn(); passed++; console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}
function near(actual, expected, description) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${description}: expected ${expected}, got ${actual}`);
}
function harness(options = {}) {
    let now = EPOCH, failFileWrite = false;
    const values = new Map(), writes = [], errors = [];
    const flow = {
        get(key, store = 'default') { return values.get(`${store}:${key}`); },
        set(key, value, store = 'default') {
            if (store === 'file' && failFileWrite) throw Error('simulated file context failure');
            values.set(`${store}:${key}`, value);
            if (store === 'file') writes.push({key, value: structuredClone(value)});
        }
    };
    const node = {status() {}, error(...args) { errors.push(args); }};
    class FakeDate extends Date { static now() { return now; } }
    const contextValues = new Map();
    const context = {get: key => contextValues.get(key), set: (key, value) => contextValues.set(key, value)};
    function run(id, msg = {}, field = 'func') {
        return new Function('msg', 'flow', 'node', 'context', 'Date', 'Buffer', byId[id][field] || '')
            (msg, flow, node, context, FakeDate, Buffer);
    }
    if (options.saved !== undefined) flow.set('vescCruiseConfig', structuredClone(options.saved), 'file');
    if (options.previous !== undefined) flow.set('vescCruise', structuredClone(options.previous), 'memory');
    const restart = () => run(CONTROL, {}, 'initialize');
    restart();
    const state = () => flow.get('vescCruise', 'memory');
    const saved = () => flow.get('vescCruiseConfig', 'file');
    const send = (topic, payload, extra = {}) => run(CONTROL, {topic, payload, ...extra});
    function motor() {
        flow.set('vesc', {config: {engineOn: true}, status: {available: true, lastRxMs: now,
            control: {protocolVersion: 1, source: 1, mode: 0, percent: 0, lastRxMs: now}},
            telemetry: {mc_fault_code: 0}}, 'memory');
    }
    function sog(kn) {
        return send('navigation.speedOverGround', kn * 1852 / 3600,
            {context: 'vessels.self', timestamp: new Date(now).toISOString()});
    }
    function tick(ms = 200, speed) {
        now += ms; motor(); if (speed !== undefined) sog(speed);
        return send('cruise_tick');
    }
    function arm(target = 0.5, speed = 0) {
        motor(); send('cruise_setpoint', target); sog(speed);
        return send('cruise_toggle', 'toggle');
    }
    function save(pid, requestId = 'browser-A-1') {
        return send('cruise_pid_config', pid, {requestId});
    }
    function frame(msg) {
        const built = run(BUILD, structuredClone(msg));
        return built ? run(CAN, built)?.payload : null;
    }
    const first = send('cruise_init');
    return {flow, run, state, saved, send, motor, sog, tick, arm, save, frame,
        restart, writes, errors, first, failFileWrites: value => {failFileWrite = value;}};
}
function reply(outputs) {
    assert.ok(Array.isArray(outputs), 'Function must return its configured output array');
    const message = outputs[5];
    assert.equal(message?.topic, 'cruise_pid_state');
    assert.ok(message.payload && typeof message.payload === 'object');
    return message.payload;
}

test('dashboard parameter editor is connected to a sixth feedback output', () => {
    const controller = byId[CONTROL];
    assert.equal(controller.outputs, 6);
    assert.equal(controller.wires.length, 6);
    const id = controller.wires[5][0];
    const editor = byId[id];
    assert.equal(editor?.type, 'ui_template');
    assert.ok(editor.wires[0].includes(CONTROL));
    const group = byId[editor.group];
    assert.equal(group?.type, 'ui_group');
    assert.match(group.name, /Reglerparameter/i);
    assert.equal(group.tab, 'ui_tab_motor');
    assert.equal(editor.fwdInMessages, false, 'UI state must not become another save request');
});

test('default coefficients are shown on startup without enabling cruise', () => {
    const h = harness();
    assert.deepEqual(h.state().pid, DEFAULT_PID);
    assert.deepEqual(reply(h.first).pid, DEFAULT_PID);
    assert.equal(h.state().enabled, false);
    assert.equal(h.state().integral, 0);
});

test('the first periodic tick publishes restored settings even before the UI inject', () => {
    const h = harness({saved: {pid: {kp: 70, ki: 3, kd: 6}}});
    h.restart();
    const out = h.send('cruise_tick');
    assert.deepEqual(reply(out).pid, {kp: 70, ki: 3, kd: 6});
    assert.equal(h.state().enabled, false);
    assert.equal(out[0].payload, 0, 'startup stop and settings feedback both survive');
});

test('legacy stored speed migrates to coefficient defaults without losing speed', () => {
    const h = harness({saved: {targetKn: 2.7}});
    assert.equal(h.state().targetKn, 2.7);
    assert.deepEqual(h.state().pid, DEFAULT_PID);
    assert.deepEqual(h.saved(), {targetKn: 2.7});
});

test('persisted coefficients restore including valid zeros and retain disabled startup', () => {
    const pid = {kp: 0, ki: 12.5, kd: 0};
    const h = harness({saved: {targetKn: 3.1, pid}, previous: {enabled: true, integral: 90}});
    assert.deepEqual(h.state().pid, pid);
    assert.deepEqual(reply(h.first).pid, pid);
    assert.equal(h.state().enabled, false);
    assert.equal(h.state().integral, 0);
    assert.equal(h.state().targetKn, 3.1);
});

test('invalid persisted coefficients fall back individually', () => {
    for (const [stored, expected] of [
        [{kp: -1, ki: 2, kd: 3}, {kp: 100, ki: 2, kd: 3}],
        [{kp: 42, ki: null, kd: Infinity}, {kp: 42, ki: 5, kd: 10}],
        [{kp: '40', ki: 0, kd: 11}, {kp: 100, ki: 0, kd: 11}],
        [{kp: 10001, ki: 1001, kd: 10001}, DEFAULT_PID],
        [{kd: 7}, {kp: 100, ki: 5, kd: 7}]
    ]) {
        const h = harness({saved: {pid: stored}});
        assert.deepEqual(h.state().pid, expected);
    }
});

test('save acknowledges applied values and request identity without starting the motor', () => {
    const h = harness(), pid = {kp: 80.5, ki: 3.25, kd: 6};
    const out = h.save(pid, 'browser-A-save-3');
    const response = reply(out);
    assert.equal(response.ok, true);
    assert.equal(response.requestId, 'browser-A-save-3');
    assert.equal(response.session, h.state().session);
    assert.deepEqual(response.pid, pid);
    assert.deepEqual(h.state().pid, pid);
    assert.deepEqual(h.saved().pid, pid);
    assert.equal(out[0], null, 'editing a disabled controller must not send a motor request');
    assert.equal(h.state().enabled, false);
});

test('speed and coefficient saves merge their shared persistent configuration', () => {
    const h = harness({saved: {targetKn: 1.5, retained: {value: 7}}});
    const pid = {kp: 65, ki: 8, kd: 14};
    h.save(pid);
    assert.equal(h.saved().targetKn, 1.5);
    assert.deepEqual(h.saved().retained, {value: 7});
    h.send('cruise_setpoint', 2.3);
    assert.deepEqual(h.saved().pid, pid);
    assert.deepEqual(h.saved().retained, {value: 7});
    assert.equal(h.saved().targetKn, 2.3);
    h.save({kp: 70, ki: 9, kd: 15});
    assert.equal(h.saved().targetKn, 2.3);
    assert.deepEqual(h.saved().pid, {kp: 70, ki: 9, kd: 15});
});

test('saving settings survives a controller restart with the selected speed', () => {
    const h = harness();
    h.send('cruise_setpoint', 1.8);
    h.save({kp: 55, ki: 2.5, kd: 8});
    h.restart();
    const state = reply(h.send('cruise_init'));
    assert.deepEqual(state.pid, {kp: 55, ki: 2.5, kd: 8});
    assert.equal(h.state().targetKn, 1.8);
    assert.equal(h.state().enabled, false);
});

test('a periodic controller tick never writes coefficient settings to disk', () => {
    const h = harness(); h.arm(0.2, 0);
    const writes = h.writes.length;
    for (let i = 0; i < 20; i++) h.tick(200, 0);
    assert.equal(h.writes.length, writes);
});

test('malformed settings are rejected atomically without changing saved or live control', () => {
    const invalid = [null, [], '100', {}, {kp: 1, ki: 2},
        {kp: '1', ki: 2, kd: 3}, {kp: null, ki: 2, kd: 3},
        {kp: NaN, ki: 2, kd: 3}, {kp: 1, ki: Infinity, kd: 3},
        {kp: -0.1, ki: 2, kd: 3}, {kp: 1, ki: -1, kd: 3},
        {kp: 1, ki: 2, kd: -1}, {kp: 10001, ki: 2, kd: 3},
        {kp: 1, ki: 1001, kd: 3}, {kp: 1, ki: 2, kd: 10001}];
    for (const pid of invalid) {
        const h = harness(); h.arm(0.5, 0.2); h.tick(200, 0.2);
        const before = structuredClone(h.state()), saved = structuredClone(h.saved());
        const writes = h.writes.length;
        const out = h.save(pid);
        assert.equal(reply(out).ok, false, `invalid settings accepted: ${JSON.stringify(pid)}`);
        assert.equal(out[0], null);
        assert.deepEqual(h.state().pid, before.pid);
        assert.equal(h.state().integral, before.integral);
        assert.equal(h.state().derivativeKnS, before.derivativeKnS);
        assert.equal(h.state().serial, before.serial);
        assert.equal(h.state().enabled, true);
        assert.deepEqual(h.saved(), saved);
        assert.equal(h.writes.length, writes);
    }
});

test('gain ranges accept both boundaries and complete zero settings', () => {
    const h = harness();
    for (const pid of [{kp: 0, ki: 0, kd: 0}, {kp: 10000, ki: 1000, kd: 10000}]) {
        assert.equal(reply(h.save(pid)).ok, true);
        assert.deepEqual(h.state().pid, pid);
    }
});

test('new Kp is used immediately on the next enable and retains natural saturation', () => {
    const h = harness(); h.save({kp: 40, ki: 0, kd: 0});
    near(h.arm(0.5, 0)[0].payload, 20, 'new P response');
    h.send('cruise_toggle', 'toggle');
    h.save({kp: 400, ki: 0, kd: 0});
    near(h.send('cruise_toggle', 'toggle')[0].payload, 100, 'new P saturation');
});

test('applying coefficients to running PID preserves I and measured derivative', () => {
    const h = harness(); h.arm(0.6, 0.2); h.tick(1000, 0.3);
    const before = structuredClone(h.state());
    assert.ok(before.integral > 0);
    assert.ok(before.derivativeKnS > 0);
    const pid = {kp: 60, ki: 7, kd: 20};
    const out = h.save(pid), after = h.state();
    assert.equal(reply(out).ok, true);
    assert.equal(after.enabled, true);
    assert.equal(after.integral, before.integral, 'save must not advance or reset I');
    assert.equal(after.derivativeKnS, before.derivativeKnS, 'save must not reset or synthesize D');
    const expected = Math.max(0, Math.min(100,
        pid.kp * (before.targetKn - before.filteredKn) + before.integral - pid.kd * before.derivativeKnS));
    near(out[0].payload, expected, 'immediate PID with new gains');
    near(after.pTerm, pid.kp * (before.targetKn - before.filteredKn), 'new P diagnostic');
    near(after.dTerm, -pid.kd * before.derivativeKnS, 'new D diagnostic');
    assert.equal(out[0]._vescAcquire, false, 'parameter editing must not acquire motor ownership');
    const frame = h.frame(out[0]);
    assert.equal(frame[5], 4, 'running PID update uses continuation opcode');
    assert.equal(frame[6], 0, 'normal RPM continuation');
});

test('new Ki affects subsequent integration and not the save event itself', () => {
    const h = harness(); h.arm(0.2, 0); h.tick(1000, 0);
    near(h.state().integral, 1, 'initial integral');
    h.save({kp: 100, ki: 10, kd: 10});
    near(h.state().integral, 1, 'save integral');
    h.tick(1000, 0);
    near(h.state().integral, 3, 'new Ki integral');
});

test('a file-store write error keeps the active coefficients and motor request unchanged', () => {
    const h = harness(); h.arm(0.5, 0.2); h.tick(200, 0.2);
    const before = structuredClone(h.state()), saved = structuredClone(h.saved());
    h.failFileWrites(true);
    const out = h.save({kp: 50, ki: 8, kd: 2}, 'file-failure');
    assert.equal(reply(out).ok, false);
    assert.equal(reply(out).requestId, 'file-failure');
    assert.equal(out[0], null);
    assert.deepEqual(h.state().pid, before.pid);
    assert.equal(h.state().integral, before.integral);
    assert.equal(h.state().serial, before.serial);
    assert.equal(h.state().enabled, before.enabled);
    assert.deepEqual(h.saved(), saved);
});

test('saving coefficients after Poti takeover cannot silently re-enable cruise or reclaim control', () => {
    const h = harness(); h.arm(0.5, 0);
    const v = h.flow.get('vesc', 'memory');
    v.status.control = {protocolVersion: 1, source: 0, mode: 0, percent: 20, lastRxMs: EPOCH};
    h.send('vesc_control_feedback', {control: v.status.control});
    assert.equal(h.state().enabled, false);
    const out = h.save({kp: 75, ki: 4, kd: 6});
    assert.equal(reply(out).ok, true);
    assert.equal(out[0], null);
    assert.equal(h.state().enabled, false);
    assert.equal(v.status.control.source, 0);
});

console.log(`\n${passed} PID settings tests passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
