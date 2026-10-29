# VESC CAN 29: PID-Tempomat, Hard-STOP und Poti/WiFi-Status

Die beiden Dateien gehören zusammen:

- [LispBM/tronic250r.lisp](../LispBM/tronic250r.lisp): aktualisierter Empfänger für den Tronic 250R mit VESC-Firmware 6.02, CAN-ID **29**.
- [NodeRED/flow.json](../NodeRED/flow.json): vollständiger Node-RED-Flow mit **62 Knoten**, einschließlich editierbarer PID-Parameter. Die drei Bedienelemente für Rekuperation, Brake und Handbrake sowie deren Konfiguration sind entfernt.

## Installation

1. Potentiometer auf Neutral stellen. Den bisherigen VESC-Tab in Node-RED deaktivieren und deployen, damit während der Umstellung keine alten Fahrbefehle eintreffen.
2. [LispBM/tronic250r.lisp](../LispBM/tronic250r.lisp) mit dem VESC Tool auf dem **Tronic mit CAN-ID 29** installieren und starten; nicht auf dem VESC Express. Beim Start wählt das Script wie bisher das Potentiometer als Quelle und übernimmt dessen Stellung.
3. Den bisherigen VESC-Tab durch [NodeRED/flow.json](../NodeRED/flow.json) ersetzen und deployen. Keine zweite aktive Kopie desselben Motorflows betreiben.
4. Im Dashboard frische VESC-Telemetrie und die Steuerquelle abwarten. Nach diesem Deploy fordert der Flow einmalig **Hard-STOP** an; der Tempomat bleibt ausgeschaltet.
5. Motor freigeben und manuell fahren oder Sollgeschwindigkeit einstellen und den Tempomat einschalten. Fahrbefehle und PID benötigen die Rückmeldung des neuen Scripts. **STOP ist auch ohne Rückmeldung verfügbar.**

Der alte Lisp-Empfänger kennt weder den neuen Hard-STOP-Befehl noch die Rückmeldung der tatsächlichen Steuerquelle. Ein Flow-Import allein genügt deshalb nicht. Die Dateien wurden lokal geprüft, aber nicht auf deinem VESC oder deiner Node-RED-Instanz installiert.

Die bestehenden Node-RED-Pakete `node-red-dashboard` und `@signalk/node-red-embedded` bleiben erforderlich. Wie im Original müssen die Kontext-Stores `memory` und `file` existieren, beispielsweise in `settings.js`:

```js
contextStorage: {
    default: "memory",
    memory: { module: "memory" },
    file: { module: "localfilesystem" }
}
```

## Bedienung und aktive Steuerquelle

Der manuelle Fahrtregler steuert **−100 bis +100 %**: rückwärts beziehungsweise vorwärts. Prozent bezeichnet weiterhin einen Drehzahlsollwert bis **±75.000 ERPM**, keine gemessene Leistung.

**STOP (HARD)** fordert aktive Motorbremsung an. Derselbe Stopp erfolgt bei manuellem Nullstellen, Motor aus, Tempomat ausschalten und beim Abbruch eines aktiven Tempomaten wegen ungültiger oder veralteter Daten. Ein neuer ausdrücklicher Fahrbefehl löst die Bremse wieder.

Das Script setzt im Hard-STOP-Modus bei jedem Motorzyklus, also **50-mal pro Sekunde**, `set-brake-rel 1.0`. Das bedeutet den maximal konfigurierten relativen Bremsstrom; die Bremsstrom-, Batterie- und Temperaturgrenzen der Firmware bleiben wirksam. Bremswirkung und Stillstand sind damit noch nicht physisch nachgewiesen. Die Bremse wirkt am Motor und garantiert keinen Stillstand des Boots über Grund. Beim elektrischen Bremsen kann Energie zurückgespeist werden; die entfernten Rekuperations-Bedienelemente ändern dieses Motorverhalten nicht.

**Das Potentiometer kann weiterhin übernehmen**, auch während Hard-STOP: Eine Bewegung um mehr als **100 mV** über **100 ms** schaltet auf Poti um. Die ursprünglichen Kalibrierwerte, ADC-Abtastung mit 500 Hz, Filterfaktoren **0,005** für den Motor und **0,20** für die Übernahmeerkennung sowie der Motorzyklus mit 50 Hz bleiben erhalten.

Bei einer Poti-Übernahme beendet Node-RED den Tempomaten **ohne Gegenbefehl**, damit das Poti die Kontrolle behält. Wiederkehrende PID-Folgebefehle können die Kontrolle auch bei verlorener Übernahmemeldung nicht zurückholen. Erst eine neue ausdrückliche Bedienung im Dashboard kann WiFi wieder übernehmen.

Es gibt keinen neuen allgemeinen WiFi-Watchdog: Der zuletzt angewendete Befehl bleibt wirksam, bis ein neuer Befehl oder die Poti-Übernahme ihn ändert. Das gilt auch für Hard-STOP. Wird Node-RED beendet oder die Verbindung unterbrochen, kann ein anschließend erzeugter Stoppbefehl den VESC erst bei bestehender Verbindung erreichen.

## PID-Tempomat

Sollgeschwindigkeit **0 bis 4 kn**, Schrittweite **0,1 kn**; Ein/Aus über **Tempomat**. Ein einziger PID berechnet alle **200 ms**:

```text
e = Sollgeschwindigkeit − gefilterte SOG              [kn]
P = Kp × e
I = I + Ki × e × dt                                  [Anti-Windup]
D = −Kd × gefilterte Änderung der SOG pro Sekunde
Drehzahlsollwert = begrenze(P + I + D, 0 %, 100 %)
```

Beim Einschalten starten I und D bei null. Mit dem Startwert **Kp=100** erzeugt **1 kn positive Abweichung sofort 100 %**. Während der Fahrt bestimmen alle drei Anteile den Ausgang. Die SOG wird durch einen gleitenden Mittelwert über **10 echte GPS-Messwerte** geglättet. Der D-Anteil verwendet die Änderung dieses Mittelwerts und bleibt separat mit **0,5 s** Zeitkonstante geglättet; Sollwertsprünge erzeugen keinen D-Stoß. Es gibt keine Stellwertrampe. Die Startwerte **Kp=100, Ki=5, Kd=10** sind noch auf dem Boot abzustimmen.

### Gleitender SOG-Mittelwert

Jede neue, gültige SOG-Messung wird einmal in das Fenster aufgenommen. Bei
vollem Fenster fällt der älteste Wert heraus. Der Regler verwendet den
arithmetischen Mittelwert der vorhandenen Werte, auch beim Einschalten;
einzelne Rohwerte umgehen die Glättung nicht. In der Anlaufphase wird durch
die tatsächlich vorhandene Anzahl geteilt, ohne Auffüllen mit Nullen.
Regelticks, doppelte oder ältere Quellzeitstempel füllen das Fenster nicht.

Die Fenstergröße steht unter **Motor → Reglerparameter → SOG-Mittelwert [Werte]**.
Vorgabe ist **10**, einstellbar sind **1–100** Werte. Sie wird zusammen mit den
PID-Werten gespeichert. Beim Verkleinern bleiben die neuesten Werte; beim
Vergrößern füllt sich das größere Fenster mit den nächsten Messungen.
Ein Fensterwechsel berechnet den Mittelwert sofort neu und setzt die
D-Steigung zurück, damit der Wechsel keinen künstlichen D-Stoß erzeugt.

Die Fenstergröße zählt Messungen, nicht Sekunden: Bei 1 Hz entsprechen zehn
Werte ungefähr zehn Sekunden, bei 5 Hz ungefähr zwei Sekunden. Dadurch
werden auch echte Geschwindigkeitsänderungen verzögert. Fenstergröße und
PID-Verstärkungen müssen zusammen auf dem Boot abgestimmt werden; die
bisherigen Verstärkungen bleiben beim Update erhalten.

Ungültige SOG oder eine Quell-/Empfangslücke von mehr als 3 s löschen die
Historie. Die nächste gültige Messung beginnt ein neues Fenster. Die
Frischeprüfung bezieht sich auf die neueste Messung und löscht keine einzelnen
älteren Fensterwerte; so funktioniert auch ein Zehnerfenster bei 1 Hz.
`navigation.speedOverGround` bleibt die unveränderte Sensorquelle.
Dashboard und `controller.cruise.sogFiltered` zeigen den vom PID verwendeten
Mittelwert; die rohe SOG wird separat angezeigt und veröffentlicht.

### Kp, Ki und Kd im Dashboard einstellen

Unter **Motor → Reglerparameter** stehen die PID-Zahlenfelder und die SOG-Fenstergröße mit den aktiven Werten.
Werte bearbeiten und **Übernehmen & speichern** klicken. **Verwerfen** setzt
den Eingabeentwurf auf die aktuell verwendeten Werte zurück. Ungespeicherte
Eingaben ändern den Regler nicht und werden durch Statusmeldungen nicht überschrieben.

| Feld | Startwert | Einstellbereich | Einheit |
| --- | ---: | ---: | --- |
| Kp | 100 | 0–10.000 | Prozentpunkte/kn |
| Ki | 5 | 0–1.000 | Prozentpunkte/(kn·s) |
| Kd | 10 | 0–10.000 | Prozentpunkte·s/kn |
| SOG-Mittelwert | 10 | 1–100, ganzzahlig | GPS-Messwerte |

Die Werte werden gemeinsam geprüft und im Datei-Kontext `vescCruiseConfig.pid`
beziehungsweise `vescCruiseConfig.sogWindowSize` gespeichert. Sie bleiben zusammen mit dem Geschwindigkeitssollwert nach einem
Neustart oder Deploy erhalten. Gespeicherte Werte von null sind gültig;
fehlende oder ungültige gespeicherte Werte erhalten den jeweiligen Startwert.

Bei laufendem Tempomat gelten gespeicherte Änderungen sofort. Integral und
bei reinen Kp-/Ki-/Kd-Änderungen auch der D-Filterzustand bleiben erhalten.
Speichern schaltet den Tempomaten nicht ein und fordert keine erneute
WiFi-Übernahme an. Die separate D-Filterzeitkonstante bleibt im `CFG`-Block
des Function-Knotens **Tempomat + Handbetrieb (PID, kn)**.

Bei **0 kn Sollgeschwindigkeit** bleibt der Tempomat eingeschaltet und fordert **Hard-STOP** an; ein positiver Sollwert lässt ihn wieder regeln. Ein durch den laufenden PID berechneter Ausgang von 0 % bei positivem Geschwindigkeitssollwert bleibt dagegen ein gewöhnlicher Drehzahlsollwert. Der PID steuert ausschließlich vorwärts; rückwärts wird manuell gefahren.

Signal K liefert `navigation.speedOverGround` für `vessels.self` in m/s; der Regler rechnet intern in kn um. Daten müssen neue Quellzeitstempel haben. Bei mehreren GPS-Quellen im Subscribe-Knoten eine passende Quelle einstellen. SOG beschreibt den Betrag der Geschwindigkeit über Grund; Strömung und Segeln können das Boot auch ohne Vorwärtsschub über dem Sollwert halten.

Ein aktiver Tempomat bricht mit Hard-STOP ab bei ungültiger beziehungsweise mehr als **3 s** alter SOG, fehlender beziehungsweise mehr als **2,5 s** alter VESC-Telemetrie, VESC-Fehler, mehr als **1,5 s** alter Steuerrückmeldung oder einer Regeltaktlücke über **1,5 s**. Anschließend ist ausdrückliches Wiedereinschalten erforderlich. Nach Deploy bleibt der Tempomat aus; Sollgeschwindigkeit und PID-Parameter werden wiederhergestellt. Manuelle Bedienung beendet den Tempomaten und übernimmt direkt mit dem gewählten Befehl.

## Dashboard und Signal-K-Status

Die Quelle stammt **vom VESC nach Anwendung seines Motorbefehls**, nicht aus dem zuletzt gesendeten WiFi-Paket. Ein gesendeter STOP wird deshalb erst nach Rückmeldung als aktiver Hard-STOP angezeigt. Die gemessene Motordrehrichtung bleibt davon getrennt: „Hard-STOP aktiv“ und „Motor dreht vorwärts“ können während des Bremsens gleichzeitig zutreffen.

Alle Pfade beginnen mit `propulsion.torqeedo.`:

| Pfad | Bedeutung / Werte |
| --- | --- |
| `controller.activeSource` | Tatsächliche Quelle: `poti`, `wifi`, `unknown` |
| `controller.activeMode` | Tatsächlich angewendet: `forward`, `reverse`, `stop`, `hardStop`, `unknown`; `stop` bezeichnet einen normalen 0-%-Drehzahlsollwert |
| `controller.hardStopActive` | Rückgemeldete aktive Bremse; `null` bei fehlender Rückmeldung |
| `controller.feedbackAvailable` | Steuerrückmeldung vollständig und höchstens 1,5 s alt |
| `controller.appliedPercent` | Rückgemeldeter Drehzahlsollwert als Verhältnis −1 bis +1 |
| `controller.command` / `commandPercent` | Zuletzt gesendeter Befehl und Sollwert; ausdrücklich keine Ausführungsbestätigung |
| `controller.commandSource` | Quelle des letzten Befehls: `manual`, `cruise`, `unknown` |
| `controller.controlStatus` | Lesbarer deutscher Text mit Modus, Motorbewegung und Steuerquelle |
| `drive.state` | Gemessen: `forward`, `reverse`, `stopped`, `fault`, `unknown`; Stillstandsbereich ±100 ERPM |
| `drive.available` / `controller.available` | Motor-Telemetrie höchstens 2 s alt; eine frische Quellenmeldung allein genügt nicht |
| `state` | Standard-Signal-K-Wert: `started`, `stopped`, `unusable`; `null` bei unbekanntem Zustand |
| `transmission.gear` | Aus angewendetem Befehl: `Forward`, `Reverse`, `Neutral`, bei VESC-Fehler `Fault`; ohne gültige Rückmeldung `null` |
| `controller.cruise.*` | Tempomat aktiv, Sollgeschwindigkeit und SOG in m/s, P/I/D und Ausgang als Verhältnis sowie Statusgrund |
| `controller.cruise.sog` | Rohe SOG in m/s |
| `controller.cruise.sogFiltered` | Vom PID verwendeter SOG-Mittelwert in m/s; bei veralteten Daten `null` |
| `controller.cruise.sogWindowSize` / `controller.cruise.sogSampleCount` | Eingestellte Fenstergröße und Anzahl der aktuell gültigen Fensterwerte |

Drehzahlen, Temperaturen, Ströme, Spannung und Leistung bleiben erhalten: **7 Polpaare**, **14:1** Getriebe, Propellerumdrehungen in **Hz**, Temperaturen in **K**, Leistung in **W**. Änderungen werden sofort veröffentlicht; zusätzlich erneuert ein vollständiger **Heartbeat jede Sekunde** die Zeitstempel gleichbleibender Werte. Bei veralteten Daten wird kein Stillstand behauptet: Eigene Statuspfade werden `unknown`, betroffene Standardwerte werden mit `null` gelöscht.

Die vorhandenen Test-Injects für **0 % / 30 %** laufen jetzt ebenfalls durch Motorfreigabe und Tempomat-Arbitrierung. Der externe Lüfter-Link und bestehende Dashboard-Gruppen müssen wie im Original im Gesamtflow vorhanden sein.

## Prüfung und Quellen

Lokal bestanden: **45 Node-RED-Funktionstests**, **24 Signal-K-Statustests**, **17 Parameter-Tests**, **18 Parameter-UI-Tests**, **24 SOG-Mittelwert-Tests** und **25 Assertions mit dem offiziellen LispBM-Interpreter aus VESC 6.02**. Die Tests prüfen unter anderem Hard-STOP-Pakete, Quellenübernahme, PID-Folgebefehle, Datenalter, SI-Umrechnung und das Speichern/Anwenden der Dashboard-Parameter. Das hypothetische Bootsmodell verwendet eigens für dieses Modell gewählte Verstärkungen; es bestätigt keine Abstimmung der Startwerte auf dem Boot. Motorfunktionen im Lisp-Test sind ersetzt; das belegt keine tatsächliche Bremskraft, Hardwarekommunikation oder Regelgüte auf dem Boot.

- [VESC 6.02 LispBM-Dokumentation](https://github.com/vedderb/bldc/blob/release_6_02/lispBM/README.md)
- [VESC 6.02: Implementierung von `set-brake-rel`](https://github.com/vedderb/bldc/blob/release_6_02/lispBM/lispif_vesc_extensions.c#L1301-L1306)
- [VESC 6.02: relative Bremsstromvorgabe](https://github.com/vedderb/bldc/blob/release_6_02/motor/mc_interface.c#L721-L733)
- [Signal-K-Schema: `state`](https://github.com/SignalK/specification/blob/master/schemas/groups/propulsion.json#L15-L35) und [`transmission.gear`](https://github.com/SignalK/specification/blob/master/schemas/groups/propulsion.json#L96-L120)

Die lesbaren JavaScript-Dateien unter [NodeRED/src](../NodeRED/src) entsprechen den Function-Knoten. [tools/build_flow.py](../tools/build_flow.py) erstellt daraus den vollständigen Import. Die lokalen Prüfungen liegen unter [tests](../tests).
