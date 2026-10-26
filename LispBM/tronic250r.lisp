; TRONIC 250R / Firmware 6.02 / CAN-ID 29
; Poti + WiFi via COMM_CUSTOM_APP_DATA (36)
; Motor +/-75000 ERPM, 50 Hz
; Poti takeover 100mV / 100ms
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

(defun clamp-command (x)
    (cond ((> x 1.0) 1.0) ((< x -1.0) -1.0) (t x)))

(defun decode-poti (v)
    (cond
        ((<= v adc-min) -1.0)
        ((< v adc-dead-low)
            (/ (- v adc-dead-low) (- adc-dead-low adc-min)))
        ((<= v adc-dead-high) 0.0)
        ((< v adc-max)
            (/ (- v adc-dead-high) (- adc-max adc-dead-high)))
        (t 1.0)))

(defun process-wifi-data (data)
    (if (>= (buflen data) 3)
        (if (= (bufget-u8 data 0) 1)
            (progn
                (setvar 'wifi-command
                    (clamp-command (/ (bufget-i16 data 1) 1000.0)))
                (if (= active-source 0)
                    (progn
                        (setvar 'adc-reference adc-takeover)
                        (setvar 'poti-takeover-counter 0)
                        (setvar 'active-source 1)))))))

(defun event-handler ()
    (loopwhile t
        (recv
            ((event-data-rx . (? data)) (process-wifi-data data))
            (_ nil))))

(defun adc-filter-loop ()
    (loopwhile t
        (progn
            (setvar 'adc-raw (get-adc 0))
            (setvar 'adc-filtered
                (+ adc-filtered
                    (* control-filter-alpha (- adc-raw adc-filtered))))
            (setvar 'adc-takeover
                (+ adc-takeover
                    (* takeover-filter-alpha (- adc-raw adc-takeover))))
            (sleep adc-loop-time))))

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
        (setvar 'poti-command (decode-poti adc-filtered))
        (if (= active-source 1)
            (progn
                (if (> (abs (- adc-takeover adc-reference))
                       poti-takeover-delta)
                    (setvar 'poti-takeover-counter
                        (+ poti-takeover-counter 1))
                    (setvar 'poti-takeover-counter 0))
                (if (>= poti-takeover-counter poti-takeover-cycles)
                    (progn
                        (setvar 'active-source 0)
                        (setvar 'poti-takeover-counter 0)))))
        (if (= active-source 1)
            (setvar 'command-value wifi-command)
            (setvar 'command-value poti-command))
        (setvar 'command-value (clamp-command command-value))
        (setvar 'target-erpm (* command-value max-erpm))
        (set-rpm target-erpm)
        (sleep motor-loop-time)))
