// Reiner PID: u = Kp * e + Integral(Ki * e) - Kd * d(SOG)/dt.
// Ausgang bleibt der vorhandene LispBM-Drehzahlsollwert in Prozent.
// Startwerte fuer Probefahrt; keine am Boot validierte Abstimmung.
const CFG = {
    KP: 100,                 // Prozentpunkte / kn
    KI: 5,                   // Prozentpunkte / (kn * s)
    KD: 10,                  // Prozentpunkte * s / kn
    FILTER_TAU_S: 0.5,       // SOG-Tiefpass
    D_FILTER_TAU_S: 0.5,     // Tiefpass der gemessenen SOG-Aenderungsrate
    MAX_PERCENT: 100,
    SOG_MAX_AGE_MS: 3000,
    SOG_MAX_M_S: 50,         // Plausibilitaetsgrenze, keine Sollgeschwindigkeit
    VESC_MAX_AGE_MS: 2500,
    CONTROL_MAX_AGE_MS: 1500,
    FUTURE_TOLERANCE_MS: 1000,
    MAX_TICK_GAP_MS: 1500
};
const now = Date.now();
const s = flow.get("vescCruise", "memory");
if (!s) return null; // On Start muss vor den Nachrichten gelaufen sein.
const v = flow.get("vesc", "memory") || {};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numeric = n => typeof n === "number" && Number.isFinite(n);
let drive = null, slider = null, manualUi = null;

function command(percent, cruise, hardStop = false) {
    s.serial += 1;
    drive = {
        topic: cruise ? "vesc_cruise_drive" : "vesc_manual_drive",
        payload: percent,
        _vescSerial: s.serial,
        _vescSession: s.session,
        _vescCruise: cruise,
        _vescHardStop: hardStop,
        _vescAcquire: cruise ? s.acquireNext === true : true
    };
    s.outputPercent = percent;
    s.acquireNext = false;
    // Anzeige aktualisieren, ohne einen manuellen Eingriff auszulösen.
    manualUi = {payload: percent, _cruiseUi: true};
}
function cancel(reason, stop) {
    s.enabled = false;
    s.integral = 0;
    s.pTerm = 0;
    s.dTerm = 0;
    s.errorKn = 0;
    s.unclampedPercent = 0;
    s.lastTickMs = 0;
    s.reason = reason;
    if (stop) command(0, false, true);
    else s.serial += 1;
}
function sogProblem() {
    if (!numeric(s.sogKn) || !numeric(s.sogTimestampMs)) return "SOG fehlt/ungueltig";
    if (now - s.sogReceivedMs > CFG.SOG_MAX_AGE_MS ||
        now - s.sogTimestampMs > CFG.SOG_MAX_AGE_MS ||
        s.sogTimestampMs - now > CFG.FUTURE_TOLERANCE_MS) return "SOG veraltet/Zeitstempel ungueltig";
    return "";
}
function motorProblem() {
    if (v.config?.engineOn !== true) return "Motor ausgeschaltet";
    if (v.status?.available !== true || !numeric(v.status?.lastRxMs) ||
        now - v.status.lastRxMs < 0 || now - v.status.lastRxMs > CFG.VESC_MAX_AGE_MS)
        return "VESC-Telemetrie fehlt/veraltet";
    if (!numeric(v.telemetry?.mc_fault_code) || v.telemetry.mc_fault_code !== 0)
        return "VESC-Fehler/Fehlerstatus fehlt";
    if (!v.status.control || now - v.status.control.lastRxMs < 0 || now - v.status.control.lastRxMs > CFG.CONTROL_MAX_AGE_MS)
        return "VESC-Steuerungsstatus fehlt: LispBM aktualisieren / Verbindung pruefen";
    return "";
}

function pid(dt) {
    if (s.targetKn === 0) {
        s.integral = 0;
        s.pTerm = 0;
        s.dTerm = 0;
        s.errorKn = 0;
        s.unclampedPercent = 0;
        command(0, true, true);
        s.reason = "PID aktiv, Sollwert 0 kn";
        return;
    }
    const problem = motorProblem() || sogProblem();
    if (problem) { cancel(problem, true); return; }
    const error = s.targetKn - s.filteredKn;
    const p = CFG.KP * error;
    // D nur aus Messwertaenderungen, damit Sollwertspruenge keinen D-Stoss erzeugen.
    const d = -CFG.KD * s.derivativeKnS;
    const beforeIntegration = p + s.integral + d;
    // Klassisches Clamping-Anti-Windup an den tatsaechlichen Ausgangsgrenzen.
    // Bei Saettigung nur integrieren, wenn der Fehler die Saettigung abbaut.
    if (!((beforeIntegration >= CFG.MAX_PERCENT && error > 0) ||
          (beforeIntegration <= 0 && error < 0))) {
        s.integral = clamp(s.integral + CFG.KI * error * dt,
                           -CFG.MAX_PERCENT, CFG.MAX_PERCENT);
    }
    s.errorKn = error;
    s.pTerm = p;
    s.dTerm = d;
    s.unclampedPercent = p + s.integral + d;
    // Keine Stellwertrampe: grosse positive Abweichung saettigt direkt auf 100 %.
    command(clamp(s.unclampedPercent, 0, CFG.MAX_PERCENT), true);
    s.reason = "PID aktiv";
}

// Ein zuvor aktiver Tempomat wird nach Redeploy beendet, niemals wieder aktiviert.
if (s.pendingStop) {
    s.pendingStop = false;
    cancel("Nach Deploy ausgeschaltet", true);
}

switch (msg.topic) {
case "navigation.speedOverGround": {
    if (msg.context !== "vessels.self") { if (drive) break; return null; }
    const stamp = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
    if (!numeric(msg.payload) || msg.payload < 0 || msg.payload > CFG.SOG_MAX_M_S || !Number.isFinite(stamp) ||
        now - stamp > CFG.SOG_MAX_AGE_MS || stamp - now > CFG.FUTURE_TOLERANCE_MS) {
        s.sogKn = null;
        s.filteredKn = null;
        if (s.enabled) cancel("SOG ungueltig/veraltet", true);
        else s.reason = "SOG ungueltig/veraltet";
        break;
    }
    // Gleiche/aeltere Zeitstempel sind kein neues GPS-Sample.
    if (numeric(s.sogTimestampMs) && stamp <= s.sogTimestampMs) break;
    const kn = msg.payload * 3600 / 1852;
    if (!Number.isFinite(kn)) {
        s.sogKn = null;
        if (s.enabled) cancel("SOG ungueltig", true);
        break;
    }
    const sampleDt = numeric(s.sogTimestampMs) ? (stamp - s.sogTimestampMs) / 1000 : 0;
    if (!numeric(s.filteredKn) || sampleDt <= 0 || sampleDt > CFG.SOG_MAX_AGE_MS / 1000) {
        s.filteredKn = kn;
        s.derivativeKnS = 0;
    } else {
        const previousFiltered = s.filteredKn;
        const alpha = 1 - Math.exp(-sampleDt / CFG.FILTER_TAU_S);
        s.filteredKn += alpha * (kn - s.filteredKn);
        const measuredDerivative = (s.filteredKn - previousFiltered) / sampleDt;
        const dAlpha = 1 - Math.exp(-sampleDt / CFG.D_FILTER_TAU_S);
        s.derivativeKnS += dAlpha * (measuredDerivative - s.derivativeKnS);
    }
    s.sogKn = kn;
    s.sogTimestampMs = stamp;
    s.sogReceivedMs = now;
    break;
}
case "cruise_setpoint": {
    if (!numeric(msg.payload) || msg.payload < 0 || msg.payload > 4) {
        node.error("Tempomat-Sollwert muss eine Zahl von 0 bis 4 kn sein", msg);
        slider = {payload: s.targetKn};
        break;
    }
    s.targetKn = Math.round(msg.payload * 10) / 10;
    flow.set("vescCruiseConfig", {targetKn: s.targetKn}, "file");
    if (s.enabled) {
        const elapsed = now - s.lastTickMs;
        if (elapsed < 0 || elapsed > CFG.MAX_TICK_GAP_MS) cancel("Regeltakt unterbrochen", true);
        else pid(0); // P wirkt sofort; Zeit fuer I ausschliesslich im Regeltakt.
    }
    break;
}
case "cruise_toggle": {
    if (s.enabled) {
        cancel("Tempomat ausgeschaltet", true);
        break;
    }
    const problem = motorProblem() || sogProblem();
    const last = flow.get("vescLastCommand", "memory");
    if (problem || (numeric(last?.percent) && last.percent < 0)) {
        s.reason = problem || "Erst manuell auf 0 %, dann Tempomat";
        break;
    }
    s.enabled = true;
    s.filteredKn = s.sogKn;
    s.derivativeKnS = 0;
    s.integral = 0; // P beim Einschalten nicht mehr durch den Integrator aufheben.
    s.lastTickMs = now;
    s.acquireNext = true;
    pid(0);
    break;
}
case "cruise_manual": {
    if (msg._cruiseUi === true) { if (drive) break; return null; }
    if (!numeric(msg.payload) || msg.payload < -100 || msg.payload > 100) { if (drive) break; return null; }
    cancel(msg.payload === 0 ? "STOP / Handbetrieb 0 %" : "Handbetrieb", false);
    if (msg.payload === 0) command(0, false, true);
    else if (v.config?.engineOn === true && !motorProblem()) command(msg.payload, false);
    else s.reason = v.config?.engineOn === true ? motorProblem() : "Motor ausgeschaltet";
    break;
}
case "cruise_stop":
    cancel("STOP", true);
    break;
case "cruise_engine_off":
    cancel("Motor ausgeschaltet", true);
    break;
case "cruise_init":
    slider = {payload: s.targetKn};
    break;
case "vesc_control_feedback": {
    const feedback = v.status.control;
    if (s.enabled && feedback?.source === 0) {
        // Poti hat physisch uebernommen: keine STOP-Anforderung dagegen senden.
        cancel("Poti hat uebernommen", false);
        s.outputPercent = feedback.percent;
        manualUi = {payload: feedback.percent, _cruiseUi: true};
    }
    if (!s.enabled && numeric(feedback?.percent))
        manualUi = {payload: feedback.percent, _cruiseUi: true};
    break;
}
case "cruise_tick": {
    if (!s.enabled) break;
    const problem = motorProblem() || sogProblem();
    if (problem) { cancel(problem, true); break; }
    const elapsed = now - s.lastTickMs;
    if (elapsed < 0 || elapsed > CFG.MAX_TICK_GAP_MS) {
        cancel("Regeltakt unterbrochen", true);
        break;
    }
    if (elapsed === 0) break;
    s.lastTickMs = now;
    pid(elapsed / 1000);
    break;
}
default:
    if (drive) break;
    return null;
}

flow.set("vescCruise", s, "memory");
const fresh = !sogProblem();
const text = `${s.enabled ? "EIN" : "AUS"} | Soll ${s.targetKn.toFixed(1)} kn | SOG ${fresh ? s.sogKn.toFixed(2) : "--"} kn | Sollwert ${s.outputPercent.toFixed(1)} % | P ${s.pTerm.toFixed(1)} / I ${s.integral.toFixed(1)} / D ${s.dTerm.toFixed(1)} | ${s.reason}`;
node.status({fill: s.enabled ? "green" : "grey", shape: s.enabled ? "dot" : "ring", text});
return [drive, {payload: s.enabled, label: s.enabled ? "Tempomat: EIN" : "Tempomat: AUS", background: s.enabled ? "#2e7d32" : "#616161"}, slider, {payload: text}, manualUi];
