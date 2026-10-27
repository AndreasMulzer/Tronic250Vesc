#!/usr/bin/env python3
"""Run actual receiver functions in the VESC 6.02 LispBM host interpreter.

Only motor and transport extensions are replaced with recording stubs.
The firmware's perpetual threads/startup are omitted from this offline test.
Usage: python3 test-tronic250r-lisp.py /path/to/test_lisp_code_cps.exe
The upstream runner returns 1 on success, 0 on a failed Lisp test.
"""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / "LispBM/tronic250r.lisp").read_text()
program = source.split("\n(app-disable-output -1)", 1)[0]
stubs = """
; VESC dynamically loads this abs helper; the generic host harness does not.
(defun abs (x) (if (< x 0) (- 0 x) x))
(def motor-kind 0)
(def motor-value 0.0)
(def motor-calls 0)
(def replies 0)
(def last-reply nil)
(def reply-motor-kind 0)
(defun set-rpm (value)
    (progn (setvar 'motor-kind 1) (setvar 'motor-value value)
           (setvar 'motor-calls (+ motor-calls 1)) t))
(defun set-brake-rel (value)
    (progn (setvar 'motor-kind 2) (setvar 'motor-value value)
           (setvar 'motor-calls (+ motor-calls 1)) t))
(defun send-data (data)
    (progn
        (setvar 'last-reply
            (list (bufget-u8 data 0) (bufget-u8 data 1)
                  (bufget-u8 data 2) (bufget-u8 data 3) (bufget-i16 data 4)))
        (setvar 'reply-motor-kind motor-kind)
        (setvar 'replies (+ replies 1)) t))
(defun expect (label value)
    (if (not value) (exit-error label)))
(defun tick ()
    (progn (motor-step) (if status-send-pending (send-applied-status))))
(defun packet-rpm (value)
    (let ((data (array-create 3)))
        (progn (bufset-u8 data 0 1) (bufset-i16 data 1 value) data)))
(defun packet-one (code)
    (let ((data (array-create 1)))
        (progn (bufset-u8 data 0 code) data)))
(defun packet-continue (mode value)
    (let ((data (array-create 4)))
        (progn (bufset-u8 data 0 4) (bufset-u8 data 1 mode)
               (bufset-i16 data 2 value) data)))
"""
checks = """
; Keep every original calibration and scheduling value.
(expect 'calibration
    (and (= max-erpm 75000.0) (= adc-min 0.0016) (= adc-dead-low 1.1320)
         (= adc-dead-high 1.4620) (= adc-max 3.2613) (= adc-loop-time 0.002)
         (= control-filter-alpha 0.005) (= takeover-filter-alpha 0.20)
         (= poti-takeover-delta 0.100) (= poti-takeover-cycles 5)
         (= motor-loop-time 0.020)))
(expect 'poti-map
    (and (= (decode-poti adc-min) -1.0) (= (decode-poti adc-dead-low) 0.0)
         (= (decode-poti adc-dead-high) 0.0) (= (decode-poti adc-max) 1.0)))

; Startup retains Poti ownership. Query never acquires WiFi or calls a motor.
(setvar 'adc-filtered 1.3)
(setvar 'adc-takeover 1.3)
(setvar 'adc-reference 1.3)
(process-wifi-data (packet-one 3))
(expect 'query-no-side-effect (and (= active-source 0) (= motor-calls 0)))
(tick)
(expect 'startup-poti (and (= motor-kind 1) (= motor-value 0.0)
                         (eq last-reply '(129 1 0 0 0))))

; Continuations cannot acquire WiFi, either RPM or hard STOP.
(process-wifi-data (packet-continue 0 700))
(tick)
(expect 'continuation-cannot-acquire (and (= active-source 0) (= motor-value 0.0)))
(process-wifi-data (packet-continue 1 0))
(tick)
(expect 'stop-continuation-cannot-acquire
    (and (= active-source 0) (= motor-kind 1) (not wifi-hard-stop)))

; Explicit manual/initial PID command acquires WiFi and freezes the reference.
(process-wifi-data (packet-rpm 500))
(expect 'acquire (and (= active-source 1) (= adc-reference 1.3)))
(tick)
(expect 'forward (and (= motor-kind 1) (= motor-value 37500.0)
                      (eq last-reply '(129 1 1 0 500)) (= reply-motor-kind 1)))
(tick)
(tick)
(expect 'last-command-holds (and (= active-source 1) (= motor-value 37500.0)))
(process-wifi-data (packet-rpm -999))
(tick)
(expect 'reverse (and (< motor-value 0) (eq last-reply '(129 1 1 0 -999))))
(process-wifi-data (packet-rpm 32000))
(tick)
(expect 'clamp (and (= motor-value 75000.0) (eq last-reply '(129 1 1 0 1000))))

; Hard STOP stays active every cycle and is reported after the brake call.
(process-wifi-data (packet-one 2))
(tick)
(expect 'hard-stop
    (and (= motor-kind 2) (= motor-value 1.0) (= command-value 0.0)
         (eq last-reply '(129 1 1 1 0)) (= reply-motor-kind 2)))
(tick)
(tick)
(expect 'hard-stop-holds (and (= active-source 1) wifi-hard-stop (= motor-kind 2)))
(process-wifi-data (packet-one 3))
(tick)
(expect 'query-does-not-release-stop (and wifi-hard-stop (= motor-kind 2)))

; Normal command releases the latch. Valid continuations update owned control.
(process-wifi-data (packet-rpm 250))
(tick)
(expect 'manual-clears-stop (and (not wifi-hard-stop) (= motor-value 18750.0)))
(process-wifi-data (packet-continue 0 -500))
(tick)
(expect 'owned-continuation (and (= motor-kind 1) (= motor-value -37500.0)
                                 (eq last-reply '(129 1 1 0 -500))))
(process-wifi-data (packet-continue 1 0))
(tick)
(expect 'owned-stop-continuation (and (= motor-kind 2) wifi-hard-stop))
(process-wifi-data (packet-continue 9 1000))
(tick)
(expect 'invalid-continuation-mode-ignored (and (= motor-kind 2) wifi-hard-stop))

; Poti movement must last five full motor cycles; the fifth releases hard STOP.
(setvar 'adc-filtered 2.0)
(setvar 'adc-takeover 1.5)
(tick)
(tick)
(tick)
(tick)
(expect 'no-early-takeover (and (= active-source 1) (= motor-kind 2)))
(tick)
(expect 'fifth-cycle-takeover
    (and (= active-source 0) (not wifi-hard-stop) (= motor-kind 1)
         (> motor-value 0) (= (ix last-reply 2) 0) (= (ix last-reply 3) 0)))

; Even with a lost takeover reply, subsequent PID messages cannot steal it back.
(process-wifi-data (packet-continue 0 1000))
(tick)
(expect 'pid-cannot-steal-poti (and (= active-source 0) (< motor-value 75000.0)))
(process-wifi-data (packet-continue 1 0))
(tick)
(expect 'pid-stop-cannot-steal-poti (and (= active-source 0) (= motor-kind 1)))

; Explicit hard STOP still acquires WiFi, and a fresh manual gesture releases it.
(process-wifi-data (packet-one 2))
(tick)
(expect 'explicit-stop-acquires (and (= active-source 1) (= motor-kind 2)
                                    (= adc-reference 1.5)))
(process-wifi-data (packet-rpm 0))
(tick)
(expect 'explicit-zero-releases (and (= motor-kind 1) (= motor-value 0.0)
                                    (not wifi-hard-stop)))

; Bad/short input has no side effects and cannot crash the event receiver.
(process-wifi-data (packet-one 1))
(process-wifi-data (packet-one 255))
(tick)
(expect 'malformed-ignored (and (= active-source 1) (= motor-kind 1)
                              (= motor-value 0.0) (not wifi-hard-stop)))
t
"""
with tempfile.TemporaryDirectory(prefix="tronic250r-lisp-") as testdir:
    testfile = Path(testdir) / "receiver-test.lisp"
    testfile.write_text(stubs + "\n" + program + "\n" + checks)
    result = subprocess.run([sys.argv[1], str(testfile)], text=True, errors="replace", capture_output=True)
print(result.stdout, end="")
print(result.stderr, end="", file=sys.stderr)
if result.returncode != 1 or "Test: OK!" not in result.stdout:
    raise SystemExit("VESC 6.02 LispBM receiver test failed")
count = sum(line.startswith("(expect ") for line in checks.splitlines())
print(f"Receiver behavior: {count} assertions passed in VESC 6.02 LispBM (64-bit host).")
