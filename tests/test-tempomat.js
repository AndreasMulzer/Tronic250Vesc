'use strict';
// Tests execute the shipped Node-RED Function node sources, without network I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, '../NodeRED/flow.json'), 'utf8'));
const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
const CONTROL = '6d560d867c410001';
const BUILD = '3d6d755ef82aefb8';
const CAN = '68e1f123023253f2';
const UPDATE = 'e9203c0993ec89ec';
const PARSER = 'd7c31336a667e50b';
const STORE = '0eb4966efd4f66ca';
const REQUEST = '41bc7523b271d968';
const SOURCE = path.join(__dirname, 'fixtures/original-flow.json');
const EPOCH = Date.parse('2026-10-26T12:00:00.000Z');
let passed = 0, failed = 0;

function test(name, fn) {
    try { fn(); passed++; console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}

function harness(options = {}) {
    let clock = EPOCH;
    const stores = new Map();
    const flow = {
        get(key, store = 'default') { return stores.get(`${store}:${key}`); },
        set(key, value, store = 'default') { stores.set(`${store}:${key}`, value); }
    };
    const errors = [], statuses = [];
    const node = {error(...args) { errors.push(args); }, status(s) { statuses.push(s); }};
    class ClockDate extends Date { static now() { return clock; } }
    const contexts = new Map();
    function context(id) {
        if (!contexts.has(id)) contexts.set(id, new Map());
        const c = contexts.get(id);
        return {get: k => c.get(k), set: (k, v) => c.set(k, v)};
    }
    function run(id, msg, field = 'func') {
        const code = byId[id][field] || '';
        return new Function('msg', 'flow', 'node', 'context', 'Date', 'Buffer', code)(msg, flow, node, context(id), ClockDate, Buffer);
    }
    if (options.saved !== undefined) flow.set('vescCruiseConfig', options.saved, 'file');
    if (options.oldState !== undefined) flow.set('vescCruise', options.oldState, 'memory');
    run(CONTROL, {}, 'initialize');
    function motor(patch = {}, refreshControl = true) {
        const v = flow.get('vesc', 'memory') || {config: {}, status: {}, telemetry: {}};
        v.config.engineOn = true;
        v.status.available = true;
        v.status.lastRxMs = clock;
        v.telemetry.mc_fault_code = 0;
        v.status.control ??= {protocolVersion: 1, source: 1, mode: 0, percent: 0, lastRxMs: clock};
        if (refreshControl) v.status.control.lastRxMs = clock;
        for (const group of ['config', 'status', 'telemetry']) Object.assign(v[group], patch[group] || {});
        flow.set('vesc', v, 'memory');
        return v;
    }
    motor();
    const send = (topic, payload, extra = {}) => run(CONTROL, {topic, payload, ...extra});
    const state = () => flow.get('vescCruise', 'memory');
    function sog(kn = 0, stamp = clock, extra = {}) {
        return send('navigation.speedOverGround', kn * 1852 / 3600,
            {context: 'vessels.self', timestamp: new Date(stamp).toISOString(), ...extra});
    }
    function advance(ms) { clock += ms; }
    function tick(ms = 200, freshSog) {
        advance(ms); motor(); if (freshSog !== undefined) sog(freshSog);
        return send('cruise_tick');
    }
    function arm(target = 2, speed = 0, initial = 0) {
        if (initial !== undefined) flow.set('vescLastCommand', {percent: initial, timestampMs: clock}, 'memory');
        send('cruise_setpoint', target); sog(speed);
        return send('cruise_toggle', 'toggle');
    }
    function frame(message) {
        if (!message) return null;
        const built = run(BUILD, structuredClone(message));
        if (!built) return null;
        const packet = run(CAN, built);
        return packet ? packet.payload : null;
    }
    // Consume the first startup message before each scenario; deployments below
    // explicitly re-run initialize to inspect their pending startup stop.
    const firstStartup = send('cruise_init');
    return {flow, run, send, state, motor, sog, advance, tick, arm, frame, errors, statuses, firstStartup, now: () => clock};
}

test('requested controls are removed and all unrelated original nodes retain their IDs and contents', () => {
    const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
    const removed = new Set(['afe159a17df708a9', '18f4174501b77d25', '322f70ba884eca60']);
    const touched = new Set(['e3e367227d20fc75', '14d03a7ff08dd7a1', '3b7c8cf2632cafb3',
        '317e1a3a7732d2e9', 'd1c6f47274ac21f4', '5536af253f412827', '4ade8ad91ac50ceb',
        'e2c96b25e47d8bd0', 'cfbc40b26ed7ac92', '93783de4631b6c04', UPDATE, BUILD, CAN, PARSER, STORE, REQUEST]);
    for (const n of source) {
        if (removed.has(n.id)) { assert.equal(byId[n.id], undefined, `removed control remains: ${n.id}`); continue; }
        assert.ok(byId[n.id], `missing original node ${n.id}`);
        if (!touched.has(n.id)) assert.deepEqual(byId[n.id], n, `unrelated node changed: ${n.id}`);
    }
    assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
});

test('every generated function source and lifecycle section compiles', () => {
    for (const n of nodes.filter(n => n.type === 'function')) {
        for (const field of ['func', 'initialize', 'finalize']) {
            assert.doesNotThrow(() => new Function('msg', 'flow', 'node', 'context', 'Date', 'Buffer', n[field] || ''), `${n.id} ${field}`);
        }
    }
});

test('generated flow contains the current reviewed function sources', () => {
    for (const [id, filename] of [[CONTROL, 'controller.js'], [BUILD, 'build-command.js'],
        [CAN, 'can-command.js'], [UPDATE, 'update-config.js'], [PARSER, 'packet-parser.js'],
        [STORE, 'store-status.js'], [REQUEST, 'request-status.js'],
        ['3b7c8cf2632cafb3', 'initialize-vesc.js'], ['e2c96b25e47d8bd0', 'status.js']]) {
        assert.equal(byId[id].func, fs.readFileSync(path.join(__dirname, '../NodeRED/src', filename), 'utf8'), `stale generated source ${filename}`);
    }
    assert.equal(byId[CONTROL].initialize, fs.readFileSync(path.join(__dirname, '../NodeRED/src/initialize.js'), 'utf8'));
});

test('startup restores target only and requires fresh SOG', () => {
    const h = harness({saved: {targetKn: 3.2}, oldState: {enabled: false, sogKn: 1, integral: 50}});
    assert.equal(h.state().targetKn, 3.2); assert.equal(h.state().enabled, false);
    assert.equal(h.state().sogKn, null); assert.equal(h.state().integral, 0);
    const out = h.send('cruise_toggle'); assert.equal(h.state().enabled, false); assert.equal(out[0], null);
    const ui = h.send('cruise_init'); assert.equal(ui[2].payload, 3.2);
});

test('startup always issues zero even without an in-memory previous process', () => {
    const h = harness();
    assert.equal(h.firstStartup[0].payload, 0);
    assert.equal(h.state().enabled, false);
    assert.ok(h.frame(h.firstStartup[0]));
});

test('SOG converts m/s to knots and ignores another vessel', () => {
    const h = harness(); h.sog(2);
    assert.ok(Math.abs(h.state().sogKn - 2) < 1e-12);
    const before = structuredClone(h.state());
    assert.equal(h.sog(99, h.now(), {context: 'vessels.other'}), null);
    assert.deepEqual(h.state(), before);
});

test('setpoint is bounded, numeric, rounded and saved without enabled state', () => {
    const h = harness(); h.send('cruise_setpoint', 1.26);
    assert.equal(h.state().targetKn, 1.3);
    assert.deepEqual(h.flow.get('vescCruiseConfig', 'file'), {targetKn: 1.3, pid: {kp: 100, ki: 5, kd: 10}, sogWindowSize: 10});
    for (const bad of [null, '', '2', -0.1, 4.1, NaN, Infinity, {}]) {
        const out = h.send('cruise_setpoint', bad);
        assert.equal(h.state().targetKn, 1.3); assert.equal(out[2].payload, 1.3);
    }
    assert.equal(h.errors.length, 8);
});

test('engine-off, absent/stale telemetry, VESC fault and absent SOG prevent enabling', () => {
    for (const patch of [
        {config: {engineOn: false}}, {status: {available: false}},
        {status: {lastRxMs: EPOCH - 2501}}, {status: {lastRxMs: EPOCH + 1}},
        {telemetry: {mc_fault_code: 1}}, {telemetry: {mc_fault_code: null}}
    ]) {
        const h = harness(); h.sog(0); h.motor(patch);
        assert.equal(h.send('cruise_toggle')[0], null); assert.equal(h.state().enabled, false);
    }
    const h = harness(); assert.equal(h.send('cruise_toggle')[0], null);
});

test('manual reverse remains available but prohibits cruise activation until neutral', () => {
    const h = harness(); h.sog(0);
    const reverse = h.send('cruise_manual', -30)[0]; assert.equal(reverse.payload, -30);
    assert.ok(h.frame(reverse));
    assert.equal(h.send('cruise_toggle')[0], null); assert.equal(h.state().enabled, false);
    assert.ok(h.frame(h.send('cruise_manual', 0)[0]));
    assert.equal(h.send('cruise_toggle')[0].payload, 0); assert.equal(h.state().enabled, true);
});

test('PID proportional action immediately saturates naturally without canceling P or ramping', () => {
    for (const [target, speed, expected] of [[4, 0, 100], [1, 0, 100], [0.5, 0, 50], [1, 0.95, 5], [1, 1.2, 0]]) {
        const h = harness(); const on = h.arm(target, speed, 30);
        assert.ok(Math.abs(on[0].payload - expected) < 1e-9, `${target} - ${speed} kn must give ${expected} % immediately, got ${on[0].payload}`);
        assert.equal(on[0]._vescCruise, true);
        assert.equal(h.state().integral, 0, 'activation must not cancel proportional action with a preloaded integral');
    }
});

test('constant small error integrates at KI and output is the continuous PID sum', () => {
    const h = harness(); assert.equal(h.arm(0.2, 0)[0].payload, 20);
    for (let i = 1; i <= 20; i++) {
        const out = h.tick(1000, 0)[0];
        assert.ok(Math.abs(h.state().integral - i) < 1e-9, `integral after ${i}s`);
        assert.ok(Math.abs(out.payload - (20 + i)) < 1e-9, `PID sum after ${i}s`);
    }
});

test('saturation blocks windup and a smaller error immediately leaves the limit without a mode switch', () => {
    const h = harness(); assert.equal(h.arm(4, 0)[0].payload, 100);
    for (let i = 0; i < 600; i++) {
        assert.equal(h.tick(200, 0)[0].payload, 100);
        assert.equal(h.state().integral, 0, 'prolonged saturation must not accumulate integral');
    }
    assert.equal(h.send('cruise_setpoint', 0.5)[0].payload, 50);
    assert.equal(h.state().enabled, true);
    assert.ok(Math.abs(h.tick(200, 0)[0].payload - 50.5) < 1e-9);
    for (let i = 0; i < 100; i++) {
        const out = h.tick(200, 8)[0];
        assert.ok(Number.isFinite(out.payload) && out.payload >= 0 && out.payload <= 100);
    }
    assert.equal(h.state().outputPercent, 0, 'sustained overspeed removes propulsion');
    for (let i = 0; i < 100; i++) h.tick(200, 0);
    assert.ok(h.state().outputPercent > 1, 'output recovers without rearming');
});

test('a setpoint change recalculates P immediately and does not cause derivative kick', () => {
    const h = harness(); const first = h.arm(0.5, 0.2)[0].payload;
    const second = h.send('cruise_setpoint', 0.6)[0].payload;
    assert.ok(Math.abs(first - 30) < 1e-9);
    assert.ok(Math.abs(second - 40) < 1e-9);
    assert.equal(h.state().integral, 0);
    assert.equal(h.state().enabled, true);
});

test('measurement derivative damps acceleration, reverses sign on deceleration and uses sample time', () => {
    for (const [start, next, sign] of [[0, 0.1, -1], [0.2, 0.1, 1]]) {
        const h = harness(); h.arm(0.5, start);
        const out = h.tick(1000, next)[0];
        const alpha = 1 - Math.exp(-1 / 0.5);
        const filtered = (start + next) / 2; // Warm-up mean of the two real samples.
        const derivative = alpha * (filtered - start); // 1 second between GPS timestamps
        assert.ok(Math.abs(h.state().filteredKn - filtered) < 1e-9);
        assert.ok(Math.abs(h.state().derivativeKnS - derivative) < 1e-9);
        assert.ok(Math.abs(h.state().dTerm + 10 * derivative) < 1e-9);
        assert.equal(Math.sign(h.state().dTerm), sign);
        assert.ok(Math.abs(out.payload - (100 * (0.5 - filtered) + h.state().integral - 10 * derivative)) < 1e-9);
    }
});

test('ticks and duplicate GPS samples hold D; setpoint changes do not create a derivative kick', () => {
    const h = harness(); h.arm(0.5, 0);
    h.tick(1000, 0.1);
    const derivative = h.state().derivativeKnS;
    const d = h.state().dTerm;
    const stamp = h.state().sogTimestampMs;
    h.sog(4, stamp); // same source timestamp: never a new measurement
    h.tick(200);
    assert.equal(h.state().derivativeKnS, derivative);
    assert.equal(h.state().dTerm, d);
    const before = h.state().outputPercent;
    const after = h.send('cruise_setpoint', 0.6)[0].payload;
    assert.ok(Math.abs(after - before - 10) < 1e-9);
    assert.equal(h.state().derivativeKnS, derivative);
    assert.equal(h.state().dTerm, d);
});

test('PID remains bounded and lower saturation does not accumulate a negative integral', () => {
    const h = harness(); assert.equal(h.arm(1, 2)[0].payload, 0);
    for (let i = 0; i < 200; i++) {
        const out = h.tick(200, 2)[0];
        assert.equal(out.payload, 0);
        assert.equal(h.state().integral, 0);
    }
    assert.ok(Math.abs(h.send('cruise_setpoint', 2.5)[0].payload - 50) < 1e-9);
});

test('hypothetical first-order boat model converges with model-specific PID gains and ten-sample SOG', () => {
    // Software-only regression: maximum 5 kn, time constant 5 seconds.
    // These assumed plant values make no claim about the physical boat.
    const h = harness(); let speed = 0;
    // Gains apply only to this assumed software plant with the added sample lag;
    // they neither change shipped defaults nor claim physical boat tuning.
    h.send('cruise_pid_config', {kp: 50, ki: 2, kd: 10, sogWindowSize: 10});
    let output = h.arm(2, speed)[0].payload;
    assert.equal(output, 100);
    let desaturated = false;
    const settled = [];
    for (let i = 1; i <= 900; i++) {
        speed += (5 * output / 100 - speed) * (1 - Math.exp(-0.2 / 5));
        output = h.tick(200, i % 5 === 0 ? speed : undefined)[0].payload;
        assert.ok(output >= 0 && output <= 100);
        assert.equal(h.state().enabled, true);
        if (output > 0 && output < 100) desaturated = true;
        if (i > 800) settled.push(speed);
    }
    assert.ok(desaturated, 'ordinary PID arithmetic should leave maximum output as speed approaches target');
    assert.ok(settled.every(v => Math.abs(v - 2) < 0.05), `steady speed range ${Math.min(...settled)}..${Math.max(...settled)} kn`);
});

test('zero target stops immediately and clears integral without disarming', () => {
    const h = harness(); h.arm(3, 0, 80);
    const out = h.send('cruise_setpoint', 0);
    assert.equal(out[0].payload, 0); assert.equal(h.state().enabled, true); assert.equal(h.state().integral, 0);
    assert.equal(h.tick(200, 2)[0].payload, 0);
});

test('toggle off, STOP and manual takeover cancel before next tick', () => {
    for (const [topic, payload, expected] of [['cruise_toggle', 'toggle', 0], ['cruise_manual', 0, 0], ['cruise_manual', -20, -20], ['cruise_manual', 12, 12]]) {
        const h = harness(); const oldDrive = h.arm(2, 0, 40)[0];
        const out = h.send(topic, payload); assert.equal(out[0].payload, expected); assert.equal(h.state().enabled, false);
        assert.equal(h.frame(oldDrive), null, 'queued old cruise command rejected');
        assert.equal(h.tick(200, 0)[0], null, 'fresh SOG cannot rearm');
    }
});

test('original STOP and engine-off graph routes reach the cruise arbiter', () => {
    assert.ok(byId['5536af253f412827'].wires[0].includes('4ade8ad91ac50ceb'));
    assert.ok(byId['5536af253f412827'].wires[0].includes(CONTROL), 'STOP must bypass dashboard slider duplicate-value suppression');
    assert.deepEqual(byId['4ade8ad91ac50ceb'].wires, [['317e1a3a7732d2e9']]);
    assert.deepEqual(byId['317e1a3a7732d2e9'].wires, [[CONTROL]]);
    assert.deepEqual(byId['d1c6f47274ac21f4'].wires, [[CONTROL]]);
    assert.deepEqual(byId[CONTROL].wires[0], ['54c6f7bb5b0e0908']);
    const h = harness(); h.arm(2, 0, 30);
    const stop = h.run('317e1a3a7732d2e9', {payload: 0});
    assert.equal(stop.topic, 'cruise_manual');
    assert.equal(h.run(CONTROL, stop)[0].payload, 0);
    assert.equal(h.state().enabled, false);
    h.sog(0); h.send('cruise_toggle');
    const engineOff = h.run(UPDATE, {topic: 'engine_on', payload: false});
    const routedOff = h.run('d58b9c7aacfcd35d', engineOff);
    assert.ok(routedOff);
    for (const rule of byId['d1c6f47274ac21f4'].rules) {
        assert.equal(rule.t, 'set'); assert.equal(rule.pt, 'msg');
        routedOff[rule.p] = rule.tot === 'num' ? Number(rule.to) : rule.to;
    }
    assert.equal(routedOff.topic, 'cruise_engine_off');
    assert.equal(h.run(CONTROL, routedOff)[0].payload, 0);
    assert.equal(h.state().enabled, false);
});

test('direct STOP disarms an active zero-target cruise independently of slider emission', () => {
    const h = harness(); h.arm(0, 0, 0); assert.equal(h.state().enabled, true);
    assert.equal(byId['5536af253f412827'].topic, 'cruise_stop');
    assert.equal(byId['5536af253f412827'].topicType, 'str');
    const out = h.send('cruise_stop', 0);
    assert.equal(out[0].payload, 0); assert.equal(h.state().enabled, false);
    assert.equal(h.tick(200, 0)[0], null);
});

test('engine off then on before a tick cannot resume or accept a queued cruise command', () => {
    const h = harness(); const queued = h.arm(2, 0, 30)[0];
    h.run(UPDATE, {topic: 'engine_on', payload: false});
    assert.equal(h.state().enabled, false); assert.equal(h.frame(queued), null);
    h.run(UPDATE, {topic: 'engine_on', payload: true});
    assert.equal(h.tick(200, 0)[0], null); assert.equal(h.state().enabled, false);
    assert.equal(h.send('cruise_engine_off', 0)[0].payload, 0);
});

test('invalid SOG cancels to zero and new valid GPS cannot rearm', () => {
    for (const bad of [null, '', '0.5', -1, NaN, Infinity, {}, undefined]) {
        const h = harness(); h.arm(2, 0, 20); h.advance(1);
        const out = h.send('navigation.speedOverGround', bad, {context: 'vessels.self', timestamp: new Date(h.now()).toISOString()});
        assert.equal(out[0].payload, 0); assert.equal(h.state().enabled, false);
        h.advance(1); h.sog(0); assert.equal(h.tick()[0], null);
    }
});

test('invalid, old and far future source timestamps cancel', () => {
    for (const timestamp of ['not-a-time', null, new Date(EPOCH - 3001).toISOString(), new Date(EPOCH + 1001).toISOString()]) {
        const h = harness(); h.arm(2, 0, 20);
        const out = h.send('navigation.speedOverGround', 0, {context: 'vessels.self', timestamp});
        assert.equal(out[0].payload, 0); assert.equal(h.state().enabled, false);
    }
});

test('duplicate and out-of-order samples cannot refresh GPS age', () => {
    const h = harness(); h.arm(2, 0, 20); const stamp = h.state().sogTimestampMs;
    h.advance(100); h.sog(0, stamp); h.sog(0, stamp - 1);
    assert.equal(h.state().sogTimestampMs, stamp); assert.equal(h.state().sogReceivedMs, EPOCH);
    let result;
    for (let i = 0; i < 15; i++) result = h.tick(200);
    assert.equal(result[0].payload, 0); assert.equal(h.state().enabled, false);
});

test('stale VESC telemetry and prolonged tick gap cancel without automatic recovery', () => {
    for (const fault of ['vesc-age', 'tick-gap']) {
        const h = harness(); h.arm(2, 0, 20);
        if (fault === 'vesc-age') {
            h.advance(200); h.sog(0); h.motor({status: {lastRxMs: h.now() - 2501}});
        } else { h.advance(1501); h.motor(); h.sog(0); }
        const out = h.send('cruise_tick'); assert.equal(out[0].payload, 0); assert.equal(h.state().enabled, false);
        assert.equal(h.tick(200, 0)[0], null);
    }
});

test('programmatic manual slider updates never cancel cruise or emit another drive', () => {
    const h = harness(); const ui = h.arm(2, 0, 20)[4];
    assert.equal(ui._cruiseUi, true);
    assert.equal(h.run('317e1a3a7732d2e9', ui), null);
    assert.equal(h.send('cruise_manual', ui.payload, {_cruiseUi: true}), null);
    assert.equal(h.state().enabled, true);
});

test('queued commands require latest serial and matching deploy session', () => {
    const h = harness(); const first = h.arm(2, 0, 20)[0]; const second = h.tick(200, 0)[0];
    assert.equal(h.frame(first), null); assert.ok(h.frame(second));
    const badSession = {...second, _vescSession: 'a different deployment'};
    assert.equal(h.frame(badSession), null);
    const badSerial = {...second, _vescSerial: second._vescSerial - 1};
    assert.equal(h.frame(badSerial), null);
    h.run(CONTROL, {}, 'initialize');
    assert.equal(h.frame(second), null); assert.equal(h.state().enabled, false);
});

test('CAN builder rejects a command overtaken after the percent builder already accepted it', () => {
    for (const interrupt of ['manual', 'off', 'deploy']) {
        const h = harness(); const drive = h.arm(2, 0, 20)[0];
        const built = h.run(BUILD, structuredClone(drive)); assert.ok(built);
        if (interrupt === 'manual') h.send('cruise_manual', 0);
        else if (interrupt === 'off') h.run(UPDATE, {topic: 'engine_on', payload: false});
        else h.run(CONTROL, {}, 'initialize');
        assert.equal(h.run(CAN, built), null, `CAN builder accepted a stale command after ${interrupt}`);
    }
});

test('redeploy stops a previously active cruise and never restores it', () => {
    const h = harness(); h.arm(2, 0, 20); h.run(CONTROL, {}, 'initialize');
    assert.equal(h.state().enabled, false); assert.equal(h.state().sogKn, null);
    const out = h.send('cruise_init'); assert.equal(out[0].payload, 0);
    h.sog(0); assert.equal(h.tick()[0], null);
});

test('redeploy pending stop survives ignored foreign, UI and unknown messages', () => {
    for (const ignored of [
        {topic: 'navigation.speedOverGround', payload: 0, context: 'vessels.other', timestamp: new Date(EPOCH).toISOString()},
        {topic: 'cruise_manual', payload: 20, _cruiseUi: true},
        {topic: 'cruise_manual', payload: 'invalid'},
        {topic: 'unknown', payload: 1}
    ]) {
        const h = harness(); h.arm(2, 0, 20); h.run(CONTROL, {}, 'initialize');
        const first = h.run(CONTROL, ignored);
        const next = h.send('cruise_init');
        assert.ok((first && first[0] && first[0].payload === 0) || (next && next[0] && next[0].payload === 0),
            `pending deploy stop lost on ignored topic ${ignored.topic}`);
    }
});

test('manual zero is an explicit hard stop and moving manual commands retain legacy acquisition frames', () => {
    const h = harness();
    const zero = h.send('cruise_manual', 0)[0];
    assert.equal(zero._vescHardStop, true);
    assert.deepEqual([...payloadOf(h.frame(zero))], [34,29,36,2]);
    assert.deepEqual([...h.frame(h.send('cruise_manual', 30)[0])], [2,6,34,29,36,1,1,44,135,56,3]);
});

// Independent packet helpers verify the actual Function-node byte streams.
function crc16(bytes) {
    let value = 0;
    for (const byte of bytes) {
        value ^= byte * 256;
        for (let bit = 0; bit < 8; bit++) value = value >= 32768 ? ((value * 2) ^ 0x1021) & 65535 : value * 2;
    }
    return value;
}
function packet(bytes) {
    const data = Buffer.from(bytes), crc = crc16(data);
    return Buffer.from([2, data.length, ...data, crc >>> 8, crc & 255, 3]);
}
function payloadOf(frame) {
    assert.ok(Buffer.isBuffer(frame));
    assert.equal(frame[0], 2); assert.equal(frame.at(-1), 3);
    assert.equal(frame.length, frame[1] + 5);
    const data = frame.subarray(2, -3);
    assert.equal(frame.readUInt16BE(frame.length - 3), crc16(data));
    return data;
}
function controlPacket({source = 1, mode = 0, value = 0, version = 1, magic = 129} = {}) {
    const data = Buffer.from([36, magic, version, source, mode, 0, 0]);
    data.writeInt16BE(value, 5);
    return packet(data);
}
function telemetryPacket(erpm = 4200, fault = 0) {
    const data = Buffer.alloc(54);
    data[0] = 4;
    data.writeInt16BE(350, 1); data.writeInt16BE(300, 3);
    data.writeInt32BE(erpm, 23); data.writeInt16BE(500, 27); data[53] = fault;
    return packet(data);
}
function received(h, bytes) {
    const result = h.run(PARSER, {payload: bytes});
    return result ? result[0] : [];
}

test('packet CRC helper matches the standard CCITT test vector', () => {
    assert.equal(crc16(Buffer.from('123456789')), 0x31c3); // XMODEM: initial value zero
});

test('only an explicit PID enable acquires control; following PID ticks preserve ownership', () => {
    const h = harness();
    const start = h.arm(2, 0)[0];
    assert.equal(start._vescAcquire, true);
    assert.deepEqual([...payloadOf(h.frame(start))], [34,29,36,1,3,232]);
    const next = h.tick(200, 0)[0];
    assert.equal(next._vescAcquire, false);
    assert.deepEqual([...payloadOf(h.frame(next))], [34,29,36,4,0,3,232]);
});

test('an active zero-kn PID uses hard-stop continuation without reacquiring Poti ownership', () => {
    const h = harness();
    const start = h.arm(0, 0)[0];
    assert.equal(start._vescHardStop, true);
    assert.deepEqual([...payloadOf(h.frame(start))], [34,29,36,2]);
    const next = h.tick(200, 0)[0];
    assert.equal(next._vescHardStop, true);
    assert.equal(next._vescAcquire, false);
    assert.deepEqual([...payloadOf(h.frame(next))], [34,29,36,4,1,0,0]);
});

test('Poti feedback disarms PID and invalidates queued output without sending a stop against Poti', () => {
    const h = harness(); const queued = h.arm(2, 0)[0];
    const built = h.run(BUILD, structuredClone(queued));
    const feedback = received(h, controlPacket({source: 0, value: -250}))[0];
    h.run(STORE, feedback);
    const out = h.run(CONTROL, feedback);
    assert.equal(out[0], null);
    assert.equal(h.state().enabled, false);
    assert.equal(h.state().outputPercent, -25);
    assert.equal(out[4].payload, -25);
    assert.equal(h.frame(queued), null);
    assert.equal(h.run(CAN, built), null);
    assert.equal(h.tick(200, 0)[0], null);
});

test('manual driving and explicit PID re-enable reacquire after Poti takeover', () => {
    const h = harness(); h.arm(2, 0);
    const feedback = received(h, controlPacket({source: 0, value: 200}))[0];
    h.run(STORE, feedback); h.run(CONTROL, feedback);
    const manual = h.send('cruise_manual', 25)[0];
    assert.equal(manual._vescAcquire, true);
    assert.deepEqual([...payloadOf(h.frame(manual))], [34,29,36,1,0,250]);
    const pid = h.send('cruise_toggle')[0];
    assert.equal(h.state().enabled, true);
    assert.equal(pid._vescAcquire, true);
    assert.equal(payloadOf(h.frame(pid))[3], 1);
});

test('missing, stale or future controller feedback blocks enabling while explicit hard STOP remains available', () => {
    for (const feedback of [undefined, {protocolVersion: 1, source: 1, mode: 0, percent: 0, lastRxMs: EPOCH - 1501},
        {protocolVersion: 1, source: 1, mode: 0, percent: 0, lastRxMs: EPOCH + 1}]) {
        const h = harness(); h.sog(0);
        const v = h.flow.get('vesc', 'memory'); v.status.control = feedback;
        assert.equal(h.send('cruise_toggle')[0], null);
        assert.equal(h.state().enabled, false);
        const stop = h.send('cruise_stop')[0];
        assert.equal(stop._vescHardStop, true);
        assert.deepEqual([...payloadOf(h.frame(stop))], [34,29,36,2]);
    }
});

test('fresh motor telemetry does not hide stale controller feedback during active PID', () => {
    const h = harness(); h.arm(2, 0);
    const originalControl = h.flow.get('vesc', 'memory').status.control.lastRxMs;
    h.advance(1501); h.motor({}, false); h.sog(0);
    assert.equal(h.flow.get('vesc', 'memory').status.control.lastRxMs, originalControl);
    const out = h.send('cruise_tick');
    assert.equal(h.state().enabled, false);
    assert.equal(out[0]._vescHardStop, true);
});

test('status requests ask separately for motor telemetry and actual Lisp control source', () => {
    const h = harness(); const frames = h.run(REQUEST, {topic: 'request'});
    assert.equal(frames.length, 1); assert.equal(frames[0].length, 2);
    assert.deepEqual(frames[0].map(m => [...payloadOf(m.payload)]), [[34,29,4], [34,29,36,3]]);
});

test('parser buffers split TCP frames and emits coalesced motor and controller replies independently', () => {
    const h = harness(); const custom = controlPacket({source: 0, value: -321});
    assert.deepEqual(received(h, custom.subarray(0, 5)), []);
    const replies = received(h, Buffer.concat([custom.subarray(5), telemetryPacket(4200)]));
    assert.equal(replies.length, 2);
    assert.equal(replies[0].topic, 'vesc_control_feedback');
    assert.deepEqual(replies[0].payload.control, {protocolVersion: 1, source: 0, mode: 0, percent: -32.1, lastRxMs: h.now()});
    assert.equal(replies[1].topic, 'vesc_telemetry');
    assert.equal(replies[1].payload.rpm, 4200);
});

test('parser rejects bad CRC, foreign CAN IDs and malformed/custom protocol frames', () => {
    const badCrc = controlPacket(); badCrc[badCrc.length - 2] ^= 1;
    const foreign = packet([34,30,36,129,1,1,0,0,0]);
    for (const invalid of [badCrc, foreign, packet([36,129,1,1,0,0]), controlPacket({magic: 128}),
        controlPacket({version: 2}), controlPacket({source: 2}), controlPacket({mode: 2}),
        controlPacket({value: 1001}), controlPacket({value: -1001}),
        controlPacket({source: 0, mode: 1}), controlPacket({mode: 1, value: 1}), packet([4])]) {
        const h = harness(); assert.deepEqual(received(h, invalid), []);
        assert.equal(h.run(PARSER, {topic: 'watchdog'}).payload.available, false);
    }
    const h = harness();
    assert.equal(received(h, Buffer.concat([badCrc, controlPacket()])).length, 1, 'bad CRC must not discard a following valid frame');
});

test('custom control replies update ownership without refreshing motor telemetry or availability', () => {
    const h = harness();
    const v = h.flow.get('vesc', 'memory');
    v.status.available = false; v.status.lastRxMs = h.now() - 10000;
    const before = structuredClone(v.telemetry);
    const feedback = received(h, controlPacket({source: 0, value: 100}))[0];
    h.run(STORE, feedback);
    const after = h.flow.get('vesc', 'memory');
    assert.equal(after.status.available, false);
    assert.equal(after.status.lastRxMs, h.now() - 10000);
    assert.deepEqual(after.telemetry, before);
    assert.equal(after.status.control.source, 0);
    assert.equal(after.status.control.percent, 10);
    assert.equal(h.run(PARSER, {topic: 'watchdog'}).payload.available, false);
});

test('VESC initialization preserves engine preference but requires new motor and ownership feedback', () => {
    const h = harness();
    h.flow.set('vesc', {config: {engineOn: false, brakeCurrent: 99}}, 'file');
    const result = h.run('3b7c8cf2632cafb3', {});
    assert.equal(result.payload, false);
    const v = h.flow.get('vesc', 'memory');
    assert.equal(v.config.engineOn, false);
    assert.equal(v.status.available, false);
    assert.equal(v.status.lastRxMs, 0);
    assert.equal(v.status.control, undefined);
    assert.deepEqual(h.flow.get('vesc', 'file'), {config: {engineOn: false}});
});

test('retained diagnostic injects pass through the same engine gate and hard STOP arbitration', () => {
    const h = harness();
    const stopInject = byId['cfbc40b26ed7ac92'], driveInject = byId['93783de4631b6c04'];
    assert.deepEqual(stopInject.wires, [[CONTROL]]); assert.deepEqual(driveInject.wires, [[CONTROL]]);
    assert.equal(stopInject.topic, 'cruise_stop'); assert.equal(stopInject.payloadType, 'num');
    assert.equal(driveInject.topic, 'cruise_manual'); assert.equal(driveInject.payloadType, 'num');
    h.run(UPDATE, {topic: 'engine_on', payload: false});
    assert.equal(h.send(driveInject.topic, Number(driveInject.payload))[0], null);
    const stop = h.send(stopInject.topic, Number(stopInject.payload))[0];
    assert.deepEqual([...payloadOf(h.frame(stop))], [34,29,36,2]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
