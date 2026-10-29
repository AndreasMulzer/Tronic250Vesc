'use strict';
// Exercise the actual exported Function nodes; no network or motor commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flowNodes = JSON.parse(fs.readFileSync(path.join(__dirname, '../NodeRED/flow.json'), 'utf8'));
const nodes = Object.fromEntries(flowNodes.map(n => [n.id, n]));
const CONTROL = '6d560d867c410001';
const BUILD = '3d6d755ef82aefb8';
const CAN = '68e1f123023253f2';
const STATUS = 'e2c96b25e47d8bd0';
const EPOCH = Date.parse('2026-10-29T12:00:00.000Z');
const PID = {kp: 100, ki: 5, kd: 10};
let passed = 0, failed = 0;

function test(name, body) {
    try { body(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
function near(actual, expected, name = 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
        `${name}: expected ${expected}, got ${actual}`);
}
function harness(saved) {
    let now = EPOCH, failFileWrite = false;
    const values = new Map(), contexts = new Map(), writes = [];
    const flow = {
        get(key, store = 'default') { return values.get(`${store}:${key}`); },
        set(key, value, store = 'default') {
            if (store === 'file' && failFileWrite) throw Error('simulated file-store failure');
            values.set(`${store}:${key}`, value);
            if (store === 'file') writes.push({key, value: structuredClone(value)});
        }
    };
    class Clock extends Date { static now() { return now; } }
    const node = {status() {}, error() {}};
    function context(id) {
        if (!contexts.has(id)) contexts.set(id, new Map());
        const c = contexts.get(id);
        return {get: key => c.get(key), set: (key, value) => c.set(key, value)};
    }
    function run(id, msg = {}, field = 'func') {
        return new Function('msg', 'flow', 'node', 'context', 'Date', 'Buffer', nodes[id][field] || '')
            (msg, flow, node, context(id), Clock, Buffer);
    }
    const state = () => flow.get('vescCruise', 'memory');
    const persisted = () => flow.get('vescCruiseConfig', 'file');
    const send = (topic, payload, extra = {}) => run(CONTROL, {topic, payload, ...extra});
    function motor(source = 1) {
        flow.set('vesc', {config: {engineOn: true},
            status: {available: true, lastRxMs: now, control: {
                protocolVersion: 1, source, mode: 0, percent: 0, lastRxMs: now}},
            telemetry: {rpm: 5880, mc_fault_code: 0}, memory: {}}, 'memory');
    }
    function advance(ms) { now += ms; motor(); }
    function sample(kn, milliseconds = 200, sourceTimestamp) {
        advance(milliseconds);
        return send('navigation.speedOverGround', kn * 1852 / 3600, {
            context: 'vessels.self', timestamp: new Date(sourceTimestamp ?? now).toISOString()
        });
    }
    function tick(milliseconds = 200) { advance(milliseconds); return send('cruise_tick'); }
    function configure(size, pid = state().pid) {
        return send('cruise_pid_config', {...pid, sogWindowSize: size}, {requestId: 'filter-editor-1'});
    }
    function enable(target = 0.5) {
        motor(); send('cruise_setpoint', target);
        return send('cruise_toggle', 'toggle');
    }
    function status() {
        const out = run(STATUS);
        return Object.fromEntries(out.payload.updates.flatMap(update => update.values || [])
            .map(({path, value}) => [path, value]));
    }
    function frame(message) {
        if (!message) return null;
        const built = run(BUILD, structuredClone(message));
        return built ? run(CAN, built)?.payload : null;
    }
    if (saved !== undefined) flow.set('vescCruiseConfig', structuredClone(saved), 'file');
    const restart = () => run(CONTROL, {}, 'initialize');
    restart(); motor();
    const initial = send('cruise_init');
    return {flow, state, persisted, send, run, motor, sample, tick, configure, enable,
        advance, status, frame, restart, initial, writes, now: () => now,
        failFileWrites: value => {failFileWrite = value;}};
}

test('default window is ten samples and startup exposes its size without restoring history', () => {
    const h = harness();
    assert.equal(h.state().sogWindowSize, 10);
    assert.deepEqual(h.state().sogSamplesKn, []);
    assert.equal(h.state().filteredKn, null);
    assert.equal(h.initial[5].payload.sogWindowSize, 10);
    assert.equal(h.state().enabled, false);
});

test('warmup divides by actual sample count rather than zero padding', () => {
    const h = harness();
    h.sample(1, 0); near(h.state().filteredKn, 1);
    h.sample(3); near(h.state().filteredKn, 2);
    h.sample(5); near(h.state().filteredKn, 3);
    assert.equal(h.state().sogSamplesKn.length, 3);
    near(h.state().sogKn, 5, 'raw SOG');
});

test('filled rolling window evicts exactly the oldest measurement', () => {
    const h = harness({sogWindowSize: 3});
    for (const n of [1, 2, 3]) h.sample(n);
    near(h.state().filteredKn, 2);
    h.sample(4); near(h.state().filteredKn, 3);
    h.sample(5); near(h.state().filteredKn, 4);
    assert.equal(h.state().sogSamplesKn.length, 3);
    h.state().sogSamplesKn.forEach((n, i) => near(n, [3, 4, 5][i]));
});

test('alternating jitter settles to the arithmetic mean over ten real readings', () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
        h.sample(i % 2 ? 3 : 1);
        if (i >= 9) near(h.state().filteredKn, 2, `mean after sample ${i + 1}`);
    }
    assert.equal(h.state().sogSamplesKn.length, 10);
    near(h.state().sogKn, 3);
});

test('one outlier loses all influence after it leaves the ten-sample window', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.sample(2);
    h.sample(12); near(h.state().filteredKn, 3);
    for (let i = 0; i < 9; i++) h.sample(2);
    near(h.state().filteredKn, 3, 'outlier still in window');
    h.sample(2); near(h.state().filteredKn, 2, 'outlier evicted');
});

test('equal values with distinct timestamps are distinct measurements', () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.sample(2);
    assert.equal(h.state().sogSamplesKn.length, 10);
    near(h.state().filteredKn, 2);
});

test('controller ticks, duplicates, old timestamps and another vessel never add samples', () => {
    const h = harness(); h.sample(1); h.sample(3);
    const stamp = h.state().sogTimestampMs;
    const before = structuredClone(h.state().sogSamplesKn);
    const mean = h.state().filteredKn, derivative = h.state().derivativeKnS;
    for (let i = 0; i < 5; i++) h.tick(200);
    h.send('navigation.speedOverGround', 20, {context: 'vessels.self', timestamp: new Date(stamp).toISOString()});
    h.send('navigation.speedOverGround', 20, {context: 'vessels.self', timestamp: new Date(stamp - 1).toISOString()});
    h.send('navigation.speedOverGround', 20, {context: 'vessels.other', timestamp: new Date(h.now()).toISOString()});
    assert.deepEqual(h.state().sogSamplesKn, before);
    assert.equal(h.state().filteredKn, mean);
    assert.equal(h.state().derivativeKnS, derivative);
});

test('ten one-Hz samples remain in the window even when the oldest is older than three seconds', () => {
    const h = harness();
    for (let i = 1; i <= 10; i++) h.sample(i, 1000);
    assert.equal(h.state().sogSamplesKn.length, 10);
    near(h.state().filteredKn, 5.5);
    assert.equal(h.state().sogTimestampMs, h.now());
});

test('invalid SOG clears history and derivative and cancels an active controller', () => {
    for (const bad of [null, '1', -1, NaN, Infinity]) {
        const h = harness(); h.sample(0); h.sample(0.2); h.enable(0.5);
        const out = h.send('navigation.speedOverGround', bad, {
            context: 'vessels.self', timestamp: new Date(h.now() + 1).toISOString()
        });
        assert.equal(h.state().enabled, false);
        assert.deepEqual(h.state().sogSamplesKn, []);
        assert.equal(h.state().sogKn, null);
        assert.equal(h.state().filteredKn, null);
        assert.equal(h.state().derivativeKnS, 0);
        assert.equal(out[0].payload, 0);
        assert.equal(out[0]._vescHardStop, true);
        h.sample(0.4);
        assert.equal(h.state().sogSamplesKn.length, 1);
        near(h.state().filteredKn, 0.4);
        assert.equal(h.state().enabled, false, 'new samples do not rearm cruise');
    }
});

test('a source-time gap resets old samples independently of receipt-time gap', () => {
    const h = harness();
    h.sample(1, 0, EPOCH - 2000);
    h.sample(4, 2000, EPOCH + 2000);
    assert.equal(h.state().sogSamplesKn.length, 1);
    near(h.state().filteredKn, 4);
    assert.equal(h.state().derivativeKnS, 0);
});

test('a receipt-time gap resets old samples even when source timestamps are close', () => {
    const h = harness();
    h.sample(1, 0, EPOCH + 1000);
    h.sample(4, 4000, EPOCH + 2000);
    assert.equal(h.state().sogSamplesKn.length, 1);
    near(h.state().filteredKn, 4);
    assert.equal(h.state().derivativeKnS, 0);
});

test('enabling the PID keeps the existing mean instead of replacing it with latest raw SOG', () => {
    const h = harness(); h.sample(0); h.sample(0.4);
    near(h.state().filteredKn, 0.2);
    const out = h.enable(0.5);
    near(h.state().filteredKn, 0.2);
    near(h.state().sogKn, 0.4);
    near(out[0].payload, 30, 'P action must use mean');
    assert.equal(h.state().sogSamplesKn.length, 2);
    assert.equal(h.state().derivativeKnS, 0, 'enable retains previous no-kick D reset');
});

test('D derives changes of the arithmetic mean using source sample time', () => {
    const h = harness();
    h.sample(0, 0);
    h.sample(1, 1000);
    near(h.state().filteredKn, 0.5);
    near(h.state().derivativeKnS, 0.5 * (1 - Math.exp(-1 / 0.5)));
    const k = harness();
    k.sample(0, 0);
    k.sample(1, 1000, EPOCH + 500);
    near(k.state().filteredKn, 0.5);
    near(k.state().derivativeKnS, 1 * (1 - Math.exp(-0.5 / 0.5)), 'source dt, not receipt dt');
});

test('shrinking the window uses newest samples without adding a GPS reading or D spike', () => {
    const h = harness();
    for (const n of [0, 0.2, 0.4, 0.6]) h.sample(n);
    h.enable(0.8); h.sample(0.8); h.tick();
    assert.ok(h.state().derivativeKnS > 0);
    const integral = h.state().integral;
    const stamp = h.state().sogTimestampMs, received = h.state().sogReceivedMs;
    const out = h.configure(2);
    assert.equal(out[5].payload.ok, true);
    assert.equal(out[5].payload.sogWindowSize, 2);
    assert.equal(h.state().sogSamplesKn.length, 2);
    near(h.state().filteredKn, 0.7);
    assert.equal(h.state().derivativeKnS, 0);
    assert.equal(h.state().integral, integral);
    assert.equal(h.state().sogTimestampMs, stamp);
    assert.equal(h.state().sogReceivedMs, received);
    assert.equal(h.state().enabled, true);
    assert.equal(out[0]._vescAcquire, false);
    assert.equal(h.frame(out[0])[5], 4, 'resize is a continuation, never an acquire');
});

test('growing a window fills from retained samples without fabricating discarded history', () => {
    const h = harness({sogWindowSize: 2});
    for (const n of [1, 2, 3, 4]) h.sample(n);
    h.configure(4);
    assert.equal(h.state().sogSamplesKn.length, 2);
    near(h.state().filteredKn, 3.5);
    h.sample(5); near(h.state().filteredKn, 4);
    h.sample(6); near(h.state().filteredKn, 4.5);
    assert.equal(h.state().sogSamplesKn.length, 4);
});

test('saving coefficients with the same window preserves measured derivative and sample history', () => {
    const h = harness(); h.sample(0); h.sample(0.2); h.enable(0.8);
    h.sample(0.4); h.tick();
    const before = structuredClone(h.state());
    h.configure(10, {kp: 80, ki: 4, kd: 9});
    assert.equal(h.state().derivativeKnS, before.derivativeKnS);
    assert.deepEqual(h.state().sogSamplesKn, before.sogSamplesKn);
    assert.equal(h.state().filteredKn, before.filteredKn);
    assert.equal(h.state().integral, before.integral);
});

test('window one exactly follows the most recent valid sample', () => {
    const h = harness({sogWindowSize: 1});
    for (const n of [1, 4, 0, 2.5]) {
        h.sample(n);
        assert.equal(h.state().sogSamplesKn.length, 1);
        near(h.state().filteredKn, n);
    }
});

test('window persists across speed changes, legacy gain saves and restart without persisting history', () => {
    const h = harness({targetKn: 0.7, pid: PID, marker: 'retained'});
    h.configure(7, {kp: 70, ki: 3, kd: 8});
    h.sample(1); h.sample(2);
    h.send('cruise_setpoint', 2.1);
    h.send('cruise_pid_config', {kp: 60, ki: 2, kd: 5});
    assert.equal(h.persisted().sogWindowSize, 7);
    assert.equal(h.persisted().targetKn, 2.1);
    assert.equal(h.persisted().marker, 'retained');
    assert.deepEqual(h.persisted().pid, {kp: 60, ki: 2, kd: 5});
    assert.equal(Object.hasOwn(h.persisted(), 'sogSamplesKn'), false);
    h.restart();
    assert.equal(h.state().sogWindowSize, 7);
    assert.equal(h.state().targetKn, 2.1);
    assert.deepEqual(h.state().sogSamplesKn, []);
    assert.equal(h.state().filteredKn, null);
    assert.equal(h.state().enabled, false);
});

test('valid persisted integer limits restore and invalid stored sizes fall back to ten', () => {
    for (const size of [1, 7, 100]) assert.equal(harness({sogWindowSize: size}).state().sogWindowSize, size);
    for (const size of [undefined, null, '10', 0, -1, 101, 1.5, NaN, Infinity, {}])
        assert.equal(harness({sogWindowSize: size}).state().sogWindowSize, 10, String(size));
});

test('invalid window edits reject all coefficients, persistence and motor output atomically', () => {
    for (const size of [null, '10', 0, -1, 101, 1.5, NaN, Infinity, {}]) {
        const h = harness({targetKn: 0.5, pid: PID, sogWindowSize: 10});
        h.sample(0.1); h.sample(0.3);
        const before = structuredClone(h.state()), stored = structuredClone(h.persisted()), count = h.writes.length;
        const out = h.configure(size, {kp: 1, ki: 2, kd: 3});
        assert.equal(out[5].payload.ok, false, String(size));
        assert.equal(out[0], null);
        assert.deepEqual(h.state(), before);
        assert.deepEqual(h.persisted(), stored);
        assert.equal(h.writes.length, count);
    }
});

test('failed file writes cannot resize the live filter', () => {
    const h = harness(); h.sample(1); h.sample(3);
    const before = structuredClone(h.state());
    h.failFileWrites(true);
    const out = h.configure(1);
    assert.equal(out[5].payload.ok, false);
    assert.equal(out[0], null);
    assert.deepEqual(h.state(), before);
});

test('editing the filter while Poti owns the motor does not emit a command or enable cruise', () => {
    const h = harness(); h.sample(1); h.sample(3); h.motor(0);
    const out = h.configure(1);
    assert.equal(out[0], null);
    assert.equal(h.state().enabled, false);
    assert.equal(h.flow.get('vesc', 'memory').status.control.source, 0);
});

test('Signal K publishes raw SOG and the used arithmetic mean separately in SI units', () => {
    const h = harness(); h.sample(1); h.sample(3);
    const values = h.status(), base = 'propulsion.torqeedo.controller.cruise.';
    near(values[base + 'sog'], 3 * 1852 / 3600);
    near(values[base + 'sogFiltered'], 2 * 1852 / 3600);
    assert.equal(values[base + 'sogWindowSize'], 10);
    assert.equal(values[base + 'sogSampleCount'], 2);
});

test('stale SOG invalidates both raw and averaged Signal K values rather than refreshing old history', () => {
    const h = harness(); h.sample(1); h.sample(3);
    h.advance(3001);
    const values = h.status(), base = 'propulsion.torqeedo.controller.cruise.';
    assert.equal(values[base + 'sog'], null);
    assert.equal(values[base + 'sogFiltered'], null);
    assert.equal(values[base + 'sogSampleCount'], 0);
});

console.log(`\n${passed} moving-average tests passed, ${failed} failed`);
if (failed) process.exitCode = 1;
