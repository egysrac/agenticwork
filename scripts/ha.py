#!/usr/bin/env python3
"""
HA CLI - rekonstrukció 2026-08-18 (a scripts/ha.py-t egy korábbi takarításkor
valaki törölte; a 2026-08-10-i ha_ws.py mintájára stdlib-only verzió).
Token: store/.homeassistant.json (base_url + long-lived token).
"""
import json, sys, urllib.request, urllib.error

CONF = '/home/alex/marveen/store/.homeassistant.json'

def cfg():
    return json.load(open(CONF))

def url(path):
    return cfg()['base_url'].rstrip('/') + path

def headers():
    return {'Authorization': 'Bearer ' + cfg()['token'], 'Content-Type': 'application/json'}

def request(method, path, data=None):
    req = urllib.request.Request(
        url(path), method=method, headers=headers(),
        data=json.dumps(data).encode() if data else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def cmd_state(eid):
    s, b = request('GET', '/api/states/' + eid)
    if s != 200:
        print('ERROR', s, b, file=sys.stderr); sys.exit(1)
    d = json.loads(b)
    print('state:', d.get('state'))
    print('attributes:', json.dumps(d.get('attributes', {}), indent=2, ensure_ascii=False))

def cmd_list(domain=None, grep=None, maxn=200):
    s, b = request('GET', '/api/states')
    if s != 200:
        print('ERROR', s, b, file=sys.stderr); sys.exit(1)
    states = json.loads(b)
    if domain:
        states = [x for x in states if x['entity_id'].startswith(domain + '.')]
    if grep:
        states = [x for x in states if grep.lower() in x['entity_id'].lower()]
    for s in states[:maxn]:
        print(f'{s["entity_id"]}\t{s["state"]}\t{s.get("attributes", {}).get("friendly_name", "")}')

def cmd_call(domain, service, entity=None, data=None):
    payload = {}
    if entity: payload['entity_id'] = entity
    if data: payload.update(data)
    s, b = request('POST', f'/api/services/{domain}/{service}', payload)
    print('status:', s, b[:200])
    if s >= 400: sys.exit(1)

def cmd_on(eid):
    cmd_call('homeassistant', 'turn_on', entity=eid)

def cmd_off(eid):
    cmd_call('homeassistant', 'turn_off', entity=eid)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: ha.py state <eid> | list [--domain D] [--grep S] [--max N] | call <domain> <service> [--entity <id>] [--data <json>] | on|off <eid>')
        sys.exit(0)
    cmd = sys.argv[1]
    if cmd == 'state':
        cmd_state(sys.argv[2])
    elif cmd == 'list':
        domain = None; grep = None; maxn = 200; i = 2
        while i < len(sys.argv):
            if sys.argv[i] == '--domain': domain = sys.argv[i+1]; i += 2
            elif sys.argv[i] == '--grep': grep = sys.argv[i+1]; i += 2
            elif sys.argv[i] == '--max': maxn = int(sys.argv[i+1]); i += 2
            else: i += 1
        cmd_list(domain, grep, maxn)
    elif cmd == 'call':
        domain = sys.argv[2]; service = sys.argv[3]; entity = None; data = None; i = 4
        while i < len(sys.argv):
            if sys.argv[i] == '--entity': entity = sys.argv[i+1]; i += 2
            elif sys.argv[i] == '--data': data = json.loads(sys.argv[i+1]); i += 2
            else: i += 1
        cmd_call(domain, service, entity, data)
    elif cmd == 'on':
        cmd_on(sys.argv[2])
    elif cmd == 'off':
        cmd_off(sys.argv[2])
    else:
        print('Unknown command:', cmd); sys.exit(1)
