# Tronic 250R – VESC

Poti-/WiFi-Steuerung für den Tronic 250R mit VESC-Firmware 6.02 und CAN-ID 29,
PID-Tempomat über Signal-K-SOG und aktivem Hard-STOP.

## Installation

Die beiden Dateien gehören zusammen:

1. [LispBM/tronic250r.lisp](LispBM/tronic250r.lisp) auf dem Tronic mit **CAN-ID 29** installieren.
2. Den bisherigen VESC-Tab durch [NodeRED/flow.json](NodeRED/flow.json) ersetzen.

Während der Umstellung Poti auf Neutral stellen und den alten Node-RED-Tab
deaktivieren. Das Script startet wie bisher mit Poti-Steuerung. Nach Deploy
fordert der neue Flow einmalig Hard-STOP an; der Tempomat bleibt aus.

Die [Installations- und Bedienungsanleitung](docs/installation.md) beschreibt
Voraussetzungen, Signal-K-Pfade, Parameter und die Grenzen der lokalen Prüfung.

## Funktionen

- Manueller Drehzahlsollwert vorwärts/rückwärts und ein reiner PID-Tempomat für **0–4 kn**.
- **Motor → Reglerparameter**: Kp, Ki und Kd im Dashboard bearbeiten, übernehmen und dauerhaft speichern.
- SOG als gleitender Mittelwert über **10 GPS-Messwerte**, Fenstergröße im Dashboard einstellbar.
- **STOP (HARD)** bremst über `set-brake-rel 1.0` im 50-Hz-Motorloop innerhalb der Firmwarelimits.
- Potiübernahme nach **100 mV / 100 ms**; PID-Folgebefehle können die Kontrolle danach nicht zurückholen.
- VESC-Rückmeldung der tatsächlichen Quelle **Poti/WiFi** und des angewendeten Modus.
- Signal-K-Status unterscheidet Anforderung, angewendeten Modus und gemessene Drehrichtung.
- Rekuperations-, Brake- und Handbrake-Bedienelemente entfernt.

Der letzte Befehl bleibt bei WiFi-Verbindungsabbruch wirksam. Es wurde kein
zusätzlicher Kommunikations-Watchdog eingeführt. Die PID-Verstärkungen sind
Startwerte; Bremswirkung und Regelgüte wurden noch nicht am Boot geprüft.

## Entwicklung und Prüfung

Die JavaScript-Quellen der Function-Knoten liegen unter [NodeRED/src](NodeRED/src).
Mit Python 3 wird daraus der vollständige Flow erzeugt:

```sh
python3 tools/build_flow.py
```

Die Tests benötigen Node.js 18 oder neuer:

```sh
node tests/test-tempomat.js
node tests/test-status.js
node tests/test-pid-settings.js
node tests/test-pid-settings-ui.js
node tests/test-sog-average.js
```

Die LispBM-Verhaltensprüfung benötigt zusätzlich den Host-Test-Runner aus
dem offiziellen VESC-Stand `release_6_02`:

```sh
python3 tests/test-tronic250r-lisp.py /pfad/zu/test_lisp_code_cps.exe
```

Lokal bestanden: **45 Flow-/Protokolltests**, **24 Status-Tests**,
**17 Parameter-Tests**, **18 Parameter-UI-Tests**, **24 SOG-Mittelwert-Tests** und
**25 LispBM-Prüfungen** mit ersetzten Motor-/Transportfunktionen.
Diese Tests belegen keine Installation oder Bremswirkung auf Hardware.

## VESC-Konfigurationen

Die bisherigen Konfigurations-Backups bleiben erhalten:

- [VESC/vesc_appconf.xml](VESC/vesc_appconf.xml): App-Konfiguration, Exportname Stand 26.10.16.
- [VESC/motor_config.xml](VESC/motor_config.xml): Motorkonfiguration, Exportname Stand 26.10.26.
