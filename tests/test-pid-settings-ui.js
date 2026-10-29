'use strict';
// Run the actual Dashboard template script with scope and timer substitutes.
// These checks cover UI state transitions; no live browser or Node-RED is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../NodeRED/src/pid-settings.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const initial = {kp: 100, ki: 5, kd: 10, sogWindowSize: 10};
const settings = (pid, sogWindowSize = 10) => ({...pid, sogWindowSize});
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

function harness() {
    let now = 100000, sequence = 0, watch, destroy, unwatched = false;
    const timers = new Map(), sent = [];
    const scope = {
        $watch(name, callback) { assert.equal(name, 'msg'); watch = callback; return () => { unwatched = true; }; },
        $on(name, callback) { assert.equal(name, '$destroy'); destroy = callback; },
        $applyAsync(callback) { callback(); },
        send(message) { sent.push(plain(message)); }
    };
    class FakeDate extends Date { static now() { return now; } }
    vm.runInNewContext(script, {
        scope, Date: FakeDate, Math,
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, {callback, at: now + delay}); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    return {
        scope, sent, timers,
        reply(pid = initial, fields = {}) {
            watch({topic: 'cruise_pid_state', payload: {
                pid: {kp: pid.kp, ki: pid.ki, kd: pid.kd},
                sogWindowSize: Object.prototype.hasOwnProperty.call(pid, 'sogWindowSize') ? pid.sogWindowSize : 10,
                ok: true, session: 'test', ...fields
            }});
        },
        raw(msg) { watch(msg); },
        edit(key, value) { scope.draft[key] = value; scope.markPidDirty(); },
        advance(ms) {
            now += ms;
            for (const [id, timer] of timers) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
        },
        destroy() { destroy(); },
        get unwatched() { return unwatched; }
    };
}

test('template has bounded gain fields, an integer sample window and explicit non-submit buttons', () => {
    for (const name of ['kp', 'ki', 'kd', 'sogWindowSize']) assert.match(html, new RegExp('ng-model="draft\\.' + name + '"'));
    assert.equal((html.match(/step="any"/g) || []).length, 3);
    assert.equal((html.match(/max="10000"/g) || []).length, 2);
    assert.equal((html.match(/max="1000"/g) || []).length, 1);
    assert.match(html, /step="1" min="1" max="100"/);
    assert.match(html, /type="button" ng-click="savePid\(\)"/);
    assert.match(html, /vescPidForm\.\$invalid/);
    assert.doesNotMatch(html, /ng-submit|ui_form/);
});

test('load waits for a valid backend state and emits no settings', () => {
    const h = harness();
    assert.equal(h.scope.ready, false);
    for (const msg of [undefined, {topic: 'other'}, {topic: 'cruise_pid_state', payload: {}},
        {topic: 'cruise_pid_state', payload: {pid: {kp: '100', ki: 5, kd: 10}}}]) h.raw(msg);
    assert.equal(h.scope.ready, false);
    h.reply();
    assert.equal(h.scope.ready, true);
    assert.deepEqual(plain(h.scope.draft), initial);
    assert.deepEqual(plain(h.scope.applied), initial);
    assert.equal(h.scope.dirty, false);
    assert.equal(h.sent.length, 0);
});

test('editing never submits automatically and replay never resets unsaved inputs', () => {
    const h = harness(); h.reply(); h.edit('kp', 125);
    assert.equal(h.scope.dirty, true);
    h.reply();
    assert.equal(h.scope.draft.kp, 125);
    assert.equal(h.scope.applied.kp, 100);
    assert.equal(h.sent.length, 0);
});

test('another browser refreshes clean fields without creating a stale draft', () => {
    const h = harness(); h.reply();
    const updated = {kp: 200, ki: 3, kd: 12};
    h.reply(updated, {requestId: 'another-browser', message: 'Saved elsewhere'});
    assert.deepEqual(plain(h.scope.draft), settings(updated));
    assert.deepEqual(plain(h.scope.applied), settings(updated));
    assert.equal(h.scope.dirty, false);
    assert.equal(h.sent.length, 0);
});

test('another browser updates applied values while preserving unsaved inputs', () => {
    const h = harness(); h.reply(); h.edit('kp', 125);
    h.reply({kp: 200, ki: 3, kd: 12}, {requestId: 'another-browser'});
    assert.deepEqual(plain(h.scope.draft), settings({kp: 125, ki: 5, kd: 10}));
    assert.deepEqual(plain(h.scope.applied), settings({kp: 200, ki: 3, kd: 12}));
    assert.equal(h.scope.dirty, true);
});

test('explicit save sends one request and waits for its own successful ACK', () => {
    const h = harness(); h.reply(); h.edit('ki', 7.5); h.scope.savePid();
    assert.equal(h.sent.length, 1);
    const request = h.sent[0];
    assert.equal(request.topic, 'cruise_pid_config');
    assert.deepEqual(request.payload, settings({kp: 100, ki: 7.5, kd: 10}));
    assert.equal(typeof request.requestId, 'string');
    assert.equal(h.scope.pending, true); assert.equal(h.timers.size, 1);
    h.scope.savePid(); assert.equal(h.sent.length, 1);
    h.reply(request.payload, {requestId: request.requestId, message: 'Übernommen und gespeichert.'});
    assert.equal(h.scope.pending, false); assert.equal(h.timers.size, 0);
    assert.equal(h.scope.dirty, false);
    assert.deepEqual(plain(h.scope.draft), request.payload);
    assert.equal(h.scope.messageKind, 'success');
    assert.match(h.scope.message, /gespeichert/);
});

test('an unrelated response cannot acknowledge or alter a pending draft', () => {
    const h = harness(); h.reply(); h.edit('kd', 20); h.scope.savePid();
    h.reply({kp: 80, ki: 3, kd: 11}, {requestId: 'other', ok: false, message: 'Foreign error'});
    assert.equal(h.scope.pending, true);
    assert.equal(h.scope.draft.kd, 20);
    assert.notEqual(h.scope.message, 'Foreign error');
    assert.equal(h.timers.size, 1);
});

test('a matching backend error keeps the draft and leaves an actionable message', () => {
    const h = harness(); h.reply(); h.edit('kp', 125); h.scope.savePid();
    h.reply(initial, {requestId: h.sent[0].requestId, ok: false, message: 'Speicherung fehlgeschlagen.'});
    assert.equal(h.scope.pending, false); assert.equal(h.timers.size, 0);
    assert.equal(h.scope.draft.kp, 125); assert.equal(h.scope.applied.kp, 100);
    assert.equal(h.scope.dirty, true); assert.equal(h.scope.messageKind, 'error');
    assert.equal(h.scope.message, 'Speicherung fehlgeschlagen.');
});

test('invalid values are rejected before sending while zero and exact limits are valid', () => {
    for (const [key, bad] of [['kp', null], ['ki', '2'], ['kd', NaN], ['kp', Infinity],
        ['ki', -0.01], ['kp', 10000.1], ['ki', 1000.1], ['kd', 10000.1]]) {
        const h = harness(); h.reply(); h.edit(key, bad); h.scope.savePid();
        assert.equal(h.sent.length, 0); assert.equal(h.scope.messageKind, 'error');
    }
    for (const values of [{kp: 0, ki: 0, kd: 0}, {kp: 10000, ki: 1000, kd: 10000}]) {
        const h = harness(); h.reply();
        Object.assign(h.scope.draft, values); h.scope.markPidDirty(); h.scope.savePid();
        assert.deepEqual(h.sent[0].payload, settings(values));
    }
});

test('discard resets to current applied values and does not submit', () => {
    const h = harness(); h.reply(); h.edit('kp', 120);
    h.reply({kp: 90, ki: 4, kd: 8}); h.scope.discardPid();
    assert.deepEqual(plain(h.scope.draft), settings({kp: 90, ki: 4, kd: 8}));
    assert.equal(h.scope.dirty, false); assert.equal(h.sent.length, 0);
    h.edit('kp', 110); h.scope.savePid(); h.scope.discardPid();
    assert.equal(h.scope.draft.kp, 110); assert.equal(h.scope.pending, true);
});

test('timeout re-enables editing and a late ACK cannot overwrite newer edits', () => {
    const h = harness(); h.reply(); h.edit('kp', 120); h.scope.savePid();
    const old = h.sent[0];
    h.advance(4999); assert.equal(h.scope.pending, true);
    h.advance(1); assert.equal(h.scope.pending, false); assert.equal(h.timers.size, 0);
    assert.match(h.scope.message, /Keine Bestätigung/); assert.equal(h.scope.draft.kp, 120);
    h.edit('kp', 130);
    h.reply(old.payload, {requestId: old.requestId});
    assert.equal(h.scope.draft.kp, 130); assert.equal(h.scope.applied.kp, 120);
    assert.equal(h.scope.dirty, true);
});

test('a retry gets a new ID and old responses cannot clear its pending state', () => {
    const h = harness(); h.reply(); h.edit('kp', 120); h.scope.savePid();
    const old = h.sent[0]; h.advance(5000); h.scope.savePid();
    assert.notEqual(h.sent[1].requestId, old.requestId);
    h.reply(old.payload, {requestId: old.requestId});
    assert.equal(h.scope.pending, true);
    h.reply(h.sent[1].payload, {requestId: h.sent[1].requestId});
    assert.equal(h.scope.pending, false);
});

test('send failure retains draft, clears timer and reports failure', () => {
    const h = harness(); h.reply(); h.edit('kp', 125);
    h.scope.send = () => { throw Error('offline'); };
    h.scope.savePid();
    assert.equal(h.scope.pending, false); assert.equal(h.timers.size, 0);
    assert.equal(h.scope.draft.kp, 125); assert.equal(h.scope.dirty, true);
    assert.match(h.scope.message, /nicht gesendet/);
});

test('destroy removes the watcher and any outstanding timeout', () => {
    const h = harness(); h.reply(); h.edit('kp', 125); h.scope.savePid();
    h.destroy();
    assert.equal(h.unwatched, true); assert.equal(h.timers.size, 0);
    h.advance(5000); assert.equal(h.sent.length, 1);
});

test('old feedback without a window initializes the ten-sample default', () => {
    const h = harness();
    h.raw({topic: 'cruise_pid_state', payload: {pid: {kp: 80, ki: 4, kd: 12}, ok: true}});
    assert.equal(h.scope.ready, true);
    assert.deepEqual(plain(h.scope.draft), settings({kp: 80, ki: 4, kd: 12}));
    assert.equal(h.sent.length, 0);
});

test('invalid window feedback is rejected rather than silently replaced', () => {
    for (const bad of [null, undefined, '10', 0, -1, 101, 10.5, NaN, Infinity]) {
        const h = harness();
        h.reply(initial, {sogWindowSize: bad});
        assert.equal(h.scope.ready, false, `unexpected initial window: ${bad}`);
        h.reply();
        h.reply({kp: 90, ki: 4, kd: 12}, {sogWindowSize: bad});
        assert.deepEqual(plain(h.scope.applied), initial, `overwrote applied state: ${bad}`);
        assert.equal(h.sent.length, 0);
    }
});

test('window edits submit only valid whole sample counts and preserve gain values', () => {
    for (const bad of [null, undefined, '20', 0, -1, 101, 1.5, NaN, Infinity]) {
        const h = harness(); h.reply(); h.edit('sogWindowSize', bad); h.scope.savePid();
        assert.equal(h.sent.length, 0, `sent invalid window: ${bad}`);
        assert.equal(h.scope.messageKind, 'error');
    }
    for (const count of [1, 20, 100]) {
        const h = harness(); h.reply(); h.edit('sogWindowSize', count);
        assert.equal(h.sent.length, 0);
        h.scope.savePid();
        assert.deepEqual(h.sent[0].payload, settings({kp: 100, ki: 5, kd: 10}, count));
        h.reply(h.sent[0].payload, {requestId: h.sent[0].requestId});
        assert.equal(h.scope.pending, false); assert.equal(h.scope.dirty, false);
        assert.equal(h.scope.applied.sogWindowSize, count);
        assert.equal(h.scope.draft.sogWindowSize, count);
    }
});

test('other browser window changes sync clean fields but do not replace window drafts', () => {
    const h = harness(); h.reply(); h.reply(initial, {sogWindowSize: 25, requestId: 'other'});
    assert.equal(h.scope.applied.sogWindowSize, 25); assert.equal(h.scope.draft.sogWindowSize, 25);
    assert.equal(h.scope.dirty, false);
    h.edit('sogWindowSize', 15);
    h.reply(initial, {sogWindowSize: 30, requestId: 'other'});
    assert.equal(h.scope.applied.sogWindowSize, 30); assert.equal(h.scope.draft.sogWindowSize, 15);
    assert.equal(h.scope.dirty, true);
    h.scope.discardPid();
    assert.equal(h.scope.draft.sogWindowSize, 30); assert.equal(h.scope.dirty, false);
    assert.equal(h.sent.length, 0);
});

console.log('\n' + passed + ' Dashboard PID settings tests passed');
