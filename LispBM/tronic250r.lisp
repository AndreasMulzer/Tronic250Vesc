; Tronic 250R: Poti + WiFi, retained last command, active hard STOP.
; VESC LispBM 6.02. Install on CAN controller 29, not on the Express.
;
; COMM_CUSTOM_APP_DATA input (big endian):
;   [1, int16]  RPM request -1000..1000; clears hard STOP.
;   [2]         latch hard STOP: set-brake-rel 1.0 every motor cycle.
;   [3]         request applied-control status; never changes ownership/output.
;   [4, mode, int16] continuation: update only while WiFi already owns control.
;               mode 0=RPM, 1=hard STOP. Cannot reclaim control from the Poti.
; Reply, sent only AFTER the motor command has been applied:
;   [129, 1, source, mode, int16]
;   source 0=Poti, 1=WiFi; mode 0=RPM, 1=hard STOP;
;   int16 is the applied normalized RPM request *1000 (0 during hard STOP).
; This confirms the applied control command, NOT measured movement/current.
;
; Moving the Poti by >100 mV for five 20 ms cycles retains manual takeover,
; including during hard STOP. No new WiFi timeout is introduced.

(def max-erpm 75000.0)
(def adc-min 0.0016)
(def adc-dead-low 1.1320)
(def adc-dead-high 1.4620)
(def adc-max 3.2613)
(def adc-loop-time 0.002)
(def control-filter-alpha 0.005)
(def takeover-filter-alpha 0.20)
(def poti-takeover-delta 0.100)
(def poti-takeover-cycles 5)
(def motor-loop-time 0.020)
(def active-source 0)
(def adc-raw 0.0)
(def adc-filtered 0.0)
(def adc-takeover 0.0)
(def adc-reference 0.0)
(def poti-takeover-counter 0)
(def poti-command 0.0)
(def wifi-command 0.0)
(def command-value 0.0)
(def target-erpm 0.0)
(def wifi-hard-stop nil)
(def status-requested nil)
(def status-send-pending nil)
(def applied-source 0)
(def applied-mode 0)
(def applied-command 0.0)
(def last-status-source -1)
(def last-status-mode -1)
; VESC 6.02 calls this array-create, not bufcreate. Allocate once.
(def status-buffer (array-create 6))

(defun clamp-command (x)
    (cond ((> x 1.0) 1.0) ((< x -1.0) -1.0) (t x)))

(defun decode-poti (v)
    (cond
        ((<= v adc-min) -1.0)
        ((< v adc-dead-low) (/ (- v adc-dead-low) (- adc-dead-low adc-min)))
        ((<= v adc-dead-high) 0.0)
        ((< v adc-max) (/ (- v adc-dead-high) (- adc-max adc-dead-high)))
        (t 1.0)))

(defun acquire-wifi ()
    (if (= active-source 0)
        (progn
            (setvar 'adc-reference adc-takeover)
            (setvar 'poti-takeover-counter 0)
            (setvar 'active-source 1))))

(defun process-wifi-data (data)
    (if (> (buflen data) 0)
        ; Keep ownership, command, STOP latch and reply request coherent.
        (atomic
            (cond
                ((and (= (bufget-u8 data 0) 1) (>= (buflen data) 3))
                    (progn
                        (setvar 'wifi-command
                            (clamp-command (/ (bufget-i16 data 1) 1000.0)))
                        (setvar 'wifi-hard-stop nil)
                        (acquire-wifi)
                        (setvar 'status-requested t)))
                ((and (= (bufget-u8 data 0) 2) (= (buflen data) 1))
                    (progn
                        (setvar 'wifi-command 0.0)
                        (setvar 'wifi-hard-stop t)
                        (acquire-wifi)
                        (setvar 'status-requested t)))
                ((and (= (bufget-u8 data 0) 3) (= (buflen data) 1))
                    (setvar 'status-requested t))
                ((and (= (bufget-u8 data 0) 4) (= (buflen data) 4)
                      (or (= (bufget-u8 data 1) 0) (= (bufget-u8 data 1) 1)))
                    (progn
                        ; Periodic PID updates must never steal manual control,
                        ; even if the Poti-takeover reply was lost in transit.
                        (if (= active-source 1)
                            (progn
                                (setvar 'wifi-hard-stop (= (bufget-u8 data 1) 1))
                                (setvar 'wifi-command
                                    (if wifi-hard-stop 0.0
                                        (clamp-command (/ (bufget-i16 data 2) 1000.0))))))
                        (setvar 'status-requested t)))))))

(defun event-handler ()
    (loopwhile t
        (recv ((event-data-rx . (? data)) (process-wifi-data data)) (_ nil))))

(defun adc-filter-loop ()
    (loopwhile t
        (progn
            (setvar 'adc-raw (get-adc 0))
            (setvar 'adc-filtered
                (+ adc-filtered (* control-filter-alpha (- adc-raw adc-filtered))))
            (setvar 'adc-takeover
                (+ adc-takeover (* takeover-filter-alpha (- adc-raw adc-takeover))))
            (sleep adc-loop-time))))

(defun motor-step ()
    ; No sleep in this short atomic block. A received command cannot create a
    ; mixture of old source/new command/new mode in the applied-control reply.
    (atomic
        (setvar 'poti-command (decode-poti adc-filtered))
        (if (= active-source 1)
            (progn
                (if (> (abs (- adc-takeover adc-reference)) poti-takeover-delta)
                    (setvar 'poti-takeover-counter (+ poti-takeover-counter 1))
                    (setvar 'poti-takeover-counter 0))
                (if (>= poti-takeover-counter poti-takeover-cycles)
                    (progn
                        (setvar 'active-source 0)
                        (setvar 'wifi-hard-stop nil)
                        (setvar 'poti-takeover-counter 0)))))
        (if (= active-source 1)
            (setvar 'command-value wifi-command)
            (setvar 'command-value poti-command))
        (setvar 'command-value (clamp-command command-value))
        (setvar 'applied-source active-source)
        (setvar 'applied-mode
            (if (and (= active-source 1) wifi-hard-stop) 1 0))
        (if (= applied-mode 1)
            (setvar 'command-value 0.0))
        (setvar 'applied-command command-value)
        (setvar 'target-erpm (* command-value max-erpm))
        (if (= applied-mode 1)
            (set-brake-rel 1.0)
            (set-rpm target-erpm))
        ; Consume requests after applying the motor command. A new request
        ; arriving after this atomic block remains queued for the next cycle.
        (setvar 'status-send-pending
            (or status-requested
                (not (= applied-source last-status-source))
                (not (= applied-mode last-status-mode))))
        (setvar 'status-requested nil)))

(defun send-applied-status ()
    (progn
        (bufset-u8 status-buffer 0 129)
        (bufset-u8 status-buffer 1 1)
        (bufset-u8 status-buffer 2 applied-source)
        (bufset-u8 status-buffer 3 applied-mode)
        (bufset-i16 status-buffer 4 (to-i (round (* applied-command 1000.0))))
        ; VESC 6.02 copies these bytes synchronously before send-data returns.
        (send-data status-buffer)
        (setvar 'last-status-source applied-source)
        (setvar 'last-status-mode applied-mode)
        (setvar 'status-send-pending nil)))

(app-disable-output -1)
(setvar 'adc-raw (get-adc 0))
(setvar 'adc-filtered adc-raw)
(setvar 'adc-takeover adc-raw)
(setvar 'adc-reference adc-raw)
(setvar 'active-source 0)
(setvar 'poti-takeover-counter 0)
(setvar 'poti-command (decode-poti adc-filtered))
(setvar 'command-value poti-command)
(setvar 'target-erpm (* command-value max-erpm))
(spawn adc-filter-loop)
(event-register-handler (spawn event-handler))
(event-enable 'event-data-rx)

(loopwhile t
    (progn
        (motor-step)
        (if status-send-pending (send-applied-status))
        (sleep motor-loop-time)))
