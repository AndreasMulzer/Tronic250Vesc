# Tronic 250R – VESC

Backup der VESC-/LispBM-Steuerung und des Node-RED-Flows.

- `NodeRED/flow.json`: Node-RED-Import
- `LispBM/tronic250r.lisp`: Poti/WLAN-Umschaltung
- `VESC/vesc_appconf.xml`: App-Konfiguration (Exportname Stand 26.10.16)
- `VESC/motor_config.xml`: Motorkonfiguration (Exportname Stand 26.10.26)

Hinweis: Bei WLAN-Verbindungsabbruch hält die aktuelle LispBM-Version den letzten Sollwert; vor produktivem Betrieb einen Kommunikations-Watchdog ergänzen.
