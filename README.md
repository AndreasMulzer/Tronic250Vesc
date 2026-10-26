# Tronic 250R – VESC

Backup der VESC-/LispBM-Steuerung und des Node-RED-Flows.

- `NodeRED/flow.json`: Node-RED-Import
- `LispBM/tronic250r.lisp`: Poti/WLAN-Umschaltung
- `VESC/config.xml`: vollständiger VESC-Tool-Export (noch ausstehend)

Hinweis: Bei WLAN-Verbindungsabbruch hält die aktuelle LispBM-Version den letzten Sollwert; vor produktivem Betrieb einen Kommunikations-Watchdog ergänzen.
