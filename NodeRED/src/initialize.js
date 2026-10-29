const saved = flow.get("vescCruiseConfig", "file");
const targetKn = typeof saved?.targetKn === "number" && Number.isFinite(saved.targetKn) && saved.targetKn >= 0 && saved.targetKn <= 4 ? saved.targetKn : 0;
function gain(key, fallback, maximum) {
    const value = saved?.pid?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : fallback;
}
flow.set("vescCruise", {
    enabled: false,
    acquireNext: false,
    targetKn,
    pid: {kp: gain("kp", 100, 10000), ki: gain("ki", 5, 1000), kd: gain("kd", 10, 10000)},
    pidUiPublished: false,
    integral: 0,
    pTerm: 0,
    dTerm: 0,
    errorKn: 0,
    unclampedPercent: 0,
    derivativeKnS: 0,
    outputPercent: 0,
    lastTickMs: 0,
    sogKn: null,
    filteredKn: null,
    sogTimestampMs: null,
    sogReceivedMs: 0,
    serial: 0,
    session: `${Date.now()}-${Math.random()}`,
    pendingStop: true,
    reason: "Bereit; Tempomat ausgeschaltet"
}, "memory");
