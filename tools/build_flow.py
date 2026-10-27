import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / "NodeRED" / "src"
original = json.loads((ROOT/'tests/fixtures/original-flow.json').read_text())
removed = {'afe159a17df708a9', '18f4174501b77d25', '322f70ba884eca60'}
nodes = [n for n in original if n['id'] not in removed]
by_id = {n['id']: n for n in nodes}
tab = 'e3e367227d20fc75'
control = '6d560d867c410001'
button = '6d560d867c410002'
slider = '6d560d867c410003'
status = '6d560d867c410004'

def code(name):
    return (HERE/name).read_text()

by_id[tab]['label'] = 'VESC CAN 29 – PID, Hard-STOP, Poti/WiFi-Status'
by_id[tab]['info'] = '''Fahrt: -100..100 % Drehzahlsollwert ueber LispBM, CAN-ID29.
STOP (HARD): expliziter LispBM-Befehl; Motorloop bremst mit dem maximal konfigurierten Bremsstrom (set-brake-rel1.0), Firmwarelimits bleiben aktiv.
Voraussetzung: beigelegtes LispBM/tronic250r.lisp auf CAN29 installieren. Alter Empfaenger kennt Hard-STOP und Quellenrueckmeldung nicht.
Reiner SOG-PID mit Ausgang0..100 %, keine zweite Regelstufe.
Poti/WiFi-Quelle wird vom Empfaenger nach Anwendung zurueckgemeldet. PID-Folgebefehle koennen eine Potiuebernahme nicht ueberschreiben.
Standard-Signal-K-state und transmission.gear plus aussagekraeftige Custom-Statuspfade. Motorbewegung, Anforderung und angewandter Modus bleiben unterscheidbar.
Rekuperations-, Brake- und Handbrake-Bedienelemente sowie deren Konfiguration sind entfernt.'''
initialize = by_id['3b7c8cf2632cafb3']
initialize.update(func=code('initialize-vesc.js'), outputs=1, wires=[['2640a0460d6bdc21']])
by_id['e9203c0993ec89ec']['func'] = code('update-config.js')

manual = by_id['317e1a3a7732d2e9']
manual.update(name='Handregler / STOP -> PID-Steuerung',
    func='if (msg._cruiseUi === true) return null;\nmsg.topic = "cruise_manual";\nreturn msg;',
    wires=[[control]])
stop_button = by_id['5536af253f412827']
stop_button.update(name='STOP (HARD)', label='STOP (HARD)', topic='cruise_stop', topicType='str')
stop_button['wires'][0].append(control)
stop = by_id['d1c6f47274ac21f4']
stop['rules'].append({'t':'set','p':'topic','pt':'msg','to':'cruise_engine_off','tot':'str'})
stop['wires'] = [[control]]

for id, filename in {
    '3d6d755ef82aefb8': 'build-command.js',
    '68e1f123023253f2': 'can-command.js',
    '41bc7523b271d968': 'request-status.js',
    'd7c31336a667e50b': 'packet-parser.js',
    '0eb4966efd4f66ca': 'store-status.js',
    'e2c96b25e47d8bd0': 'status.js'
}.items():
    by_id[id]['func'] = code(filename)
by_id['68e1f123023253f2']['name'] = 'VESC CAN29: Fahrt / Hard-STOP / PID-Folge'
by_id['0eb4966efd4f66ca']['wires'][0].append(control)
by_id['e2c96b25e47d8bd0']['initialize'] = 'context.set("fullSent", false); context.set("lastSent", {}); context.set("lastHeartbeatMs", 0);'
by_id['e2c96b25e47d8bd0']['wires'][0].append('6d560d867c410009')

# Auch vorhandene Test-Injects durch Freigabe und Arbitrierung fuehren.
for id, name, topic, value in [
    ('cfbc40b26ed7ac92', 'Test STOP (HARD)', 'cruise_stop', '0'),
    ('93783de4631b6c04', 'Test Fahrt30 % (mit Freigabe)', 'cruise_manual', '30')
]:
    by_id[id].update(name=name, topic=topic, payload=value, payloadType='num', wires=[[control]])

def add(id, type, name, x, y, wires, **fields):
    nodes.append(dict(id=id, type=type, z=tab, name=name, x=x, y=y, wires=wires, **fields))

add(control, 'function', 'Tempomat + Handbetrieb (PID, kn)', 580, 1380,
    [['54c6f7bb5b0e0908'], [button], [slider], [status], ['4ade8ad91ac50ceb']],
    func=code('controller.js'), outputs=5, timeout=0, noerr=0,
    initialize=code('initialize.js'), finalize='', libs=[])
add(button, 'ui_button', 'Tempomat EIN / AUS', 930, 1280, [[control]],
    group='ui_group_motor', order=9, width=9, height=1, passthru=False,
    label='{{msg.label || "Tempomat: AUS"}}', tooltip='Ein/Aus; Ausschalten fordert Hard-STOP an',
    color='#ffffff', bgcolor='{{msg.background || "#616161"}}', className='', icon='speed',
    payload='toggle', payloadType='str', topic='cruise_toggle', topicType='str')
add(slider, 'ui_slider', 'Tempomat Sollgeschwindigkeit', 950, 1360, [[control]],
    label='Geschwindigkeit {{value | number:1}} kn', tooltip='0 bis4kn;0kn fordert Hard-STOP an',
    group='ui_group_motor', order=10, width=9, height=1, passthru=False,
    outs='end', topic='cruise_setpoint', topicType='str', min=0, max=4, step=0.1, className='')
add(status, 'ui_text', 'PID-Status / SOG / P-I-D', 940, 1440, [],
    group='ui_group_motor', order=11, width=9, height=2, label='Tempomat',
    format='{{msg.payload}}', layout='col-center', className='', style=False,
    font='', fontSize=16, color='#000000')
add('6d560d867c410005', 'signalk-subscribe', 'SOG m/s (alle Samples, mit Zeitstempel)',
    210, 1280, [[control]], mode='sendAll', flatten=True, context='vessels.self',
    path='navigation.speedOverGround', source='', period='200')
add('6d560d867c410006', 'inject', 'Tempomat Regeltakt200ms', 190, 1360, [[control]],
    props=[{'p':'topic','vt':'str'}], repeat='0.2', crontab='', once=False, onceDelay=0.1, topic='cruise_tick')
add('6d560d867c410007', 'inject', 'Tempomat UI initialisieren', 190, 1440, [[control]],
    props=[{'p':'topic','vt':'str'}], repeat='', crontab='', once=True, onceDelay=0.6, topic='cruise_init')
add('6d560d867c410008', 'comment', 'PID / Hard-STOP / Rueckmeldung', 320, 1200, [], info=by_id[tab]['info']+'''
Motor einschalten, frische SOG, Motortelemetrie und Quellenrueckmeldung abwarten, Geschwindigkeit waehlen, Tempomat einschalten.
STOP, Motor-Aus, Tempomat-Aus und Datenfehler: Hard-STOP; PID beendet. Manueller Slider beendetPID; Nullstellung fordertHard-STOP an.
Potiuebernahme beendetPID ohne Gegenbefehl; fuer erneuteWiFiuebernahme explizitTempomat/Handreglerbetatigen.
CMD1:WiFiFahrt/acquire;CMD2:Hard-STOP/acquire;CMD3:Abfrage;CMD4:Folgebefehl nur beiWiFi-Besitz. Rueckmeldung129/v1 mitQuelle,Modus,Sollwert.
Poti-Kalibrierung/Filter/100mV/100ms/Last-command-holds bleiben im Lisp erhalten. Keine Node-RED-Fahrtwiederholung ausserPID.
PID:Kp100/Ki5/Kd10, SOG/D-Filter0.5s, Takt0.2s, Ausgang0..100%. Parameter amBoot abstimmen.
NachDeploy einmalHard-STOP; Tempomat bleibt aus. Storememory/file wieOriginal. ExternerLuefterlink bleibt erhalten.
Installation: zuerstLispaufCAN29, dannbestehendenVESC-TabdurchdiesenFlowersetzen. KeinHardwaretestdurchExport.''')
add('6d560d867c410009', 'function', 'SignalK-Motorstatus -> Anzeige', 1290, 1240, [['6d560d867c41000a']],
    func='const item=msg.payload?.updates?.flatMap(u=>u.values||[]).find(v=>v.path==="propulsion.torqeedo.controller.controlStatus");\nreturn item?{payload:item.value}:null;',
    outputs=1, timeout=0, noerr=0, initialize='', finalize='', libs=[])
add('6d560d867c41000a', 'ui_text', 'Quelle und Motorstatus (VESC-Rueckmeldung)', 1540, 1240, [],
    group='ui_group_motor', order=12, width=9, height=3, label='Motor / Steuerquelle',
    format='{{msg.payload}}', layout='col-center', className='', style=False,
    font='', fontSize=16, color='#000000')

(ROOT/'NodeRED/flow.json').write_text(json.dumps(nodes, ensure_ascii=False, indent=2)+'\n')
print(f'Created {len(nodes)} nodes; removed {len(removed)} obsolete UI nodes.')
