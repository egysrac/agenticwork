#!/usr/bin/env python3
"""Two-way sync between the local kanban (dashboard API) and a Notion database.

Deterministic, dependency-free (stdlib only). Meant to run from cron (NOT an LLM
turn). Reconciles by a LocalID property that maps a Notion page to a local card.

Change detection is CONTENT-BASED (per-record field signature), not timestamp:
Notion's last_edited_time is only minute-granular, which makes timestamp diffing
unreliable. Instead we store the last-agreed signature per card and compare.

Rules (Notion is primary on conflict):
  * Only the side whose signature differs from the last-agreed one is the change;
    that side is pushed to the other. If both differ -> Notion wins.
  * Notion page without LocalID  -> new card from Alex   -> insert local + backfill LocalID.
  * Local card without a Notion row -> new card from me   -> create Notion page.
  * Local card archived/removed -> archive the Notion page.
  * (v1 limitation) A page Alex deletes/trashes in Notion is not detected, so it
    is not removed locally. Moving a card to 'done' is a status change and syncs.

Config: store/.dashboard-token, store/.notion.json (token + kanban_db_id).
State:  store/notion-kanban-sync-state.json  ({"records": {localid: sig}}).
"""
import os
import sys
import json
import time
import hashlib
import datetime
import urllib.request
import urllib.error
from os.path import join, dirname, abspath

ROOT = dirname(dirname(abspath(__file__)))
STORE = join(ROOT, 'store')
DASH = 'http://localhost:3420'
NOTION = 'https://api.notion.com/v1'
STATE_FILE = join(STORE, 'notion-kanban-sync-state.json')

FIELDS = ['title', 'status', 'priority', 'assignee', 'description']


def _dash_token():
    with open(join(STORE, '.dashboard-token')) as f:
        return f.read().strip()


def _notion_cfg():
    with open(join(STORE, '.notion.json')) as f:
        c = json.load(f)
    return c.get('token'), c.get('kanban_db_id'), c.get('version', '2022-06-28')


def _req(url, method='GET', headers=None, body=None):
    data = None
    h = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            payload = r.read().decode()
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                return payload
    except urllib.error.HTTPError as e:
        sys.stderr.write(f'{method} {url} -> HTTP {e.code}: {e.reason}\n')
        raise


def dash_headers():
    return {'Authorization': f'Bearer {_dash_token()}'}


def local_cards():
    r = _req(f'{DASH}/api/kanban', headers=dash_headers())
    cards = r if isinstance(r, list) else r.get('cards', [])
    return [c for c in cards if not c.get('archived_at')]


def local_create(card):
    body = {k: card.get(k, '') for k in FIELDS}
    r = _req(f'{DASH}/api/kanban', method='POST', headers=dash_headers(), body=body)
    return r.get('id'), r.get('seq')


def local_update(cid, card):
    body = {k: card.get(k, '') for k in FIELDS}
    _req(f'{DASH}/api/kanban/{cid}', method='PUT', headers=dash_headers(), body=body)


def notion_headers():
    tok, db, ver = _notion_cfg()
    return {
        'Authorization': f'Bearer {tok}',
        'Notion-Version': ver,
        'Content-Type': 'application/json',
    }


def _plain(prop, kind):
    if not prop:
        return None
    if kind == 'title':
        return ''.join(p.get('plain_text', '') for p in prop.get('title', [])).strip() or None
    if kind == 'rich_text':
        return ''.join(p.get('plain_text', '') for p in prop.get('rich_text', [])).strip() or None
    if kind == 'select':
        s = prop.get('select')
        return s.get('name') if s else None
    return None


def notion_pages():
    tok, db, ver = _notion_cfg()
    out = []
    cursor = None
    while True:
        body = {'page_size': 100}
        if cursor:
            body['start_cursor'] = cursor
        r = _req(f'{NOTION}/databases/{db}/query', method='POST', headers=notion_headers(), body=body)
        for p in r.get('results', []):
            props = p.get('properties', {})
            out.append({
                'page_id': p.get('id'),
                'archived': p.get('archived', False),
                'localid': _plain(props.get('LocalID', {}), 'rich_text'),
                'title': _plain(props.get('Name', {}), 'title'),
                'status': _plain(props.get('Status', {}), 'select'),
                'priority': _plain(props.get('Priority', {}), 'select'),
                'assignee': _plain(props.get('Assignee', {}), 'rich_text'),
                'description': _plain(props.get('Description', {}), 'rich_text'),
            })
        if not r.get('has_more'):
            break
        cursor = r.get('next_cursor')
    return out


def _props(card):
    def rt(s, limit=1900):
        if not s:
            return {'rich_text': []}
        return {'rich_text': [{'text': {'content': str(s)[:limit]}}]}

    p = {}
    title = str(card.get('title', '') or '')[:1900]
    p['Name'] = {'title': [{'text': {'content': title}}]}
    p['Description'] = rt(card.get('description', ''))
    p['Assignee'] = rt(card.get('assignee', ''))
    if card.get('status'):
        p['Status'] = {'select': {'name': card['status']}}
    if card.get('priority'):
        p['Priority'] = {'select': {'name': card['priority']}}
    p['LocalID'] = rt(card.get('id', ''))
    return p


def notion_create(card):
    tok, db, ver = _notion_cfg()
    body = {'parent': {'database_id': db}, 'properties': _props(card)}
    r = _req(f'{NOTION}/pages', method='POST', headers=notion_headers(), body=body)
    return r.get('id')


def notion_update(page_id, card):
    body = {'properties': _props(card)}
    _req(f'{NOTION}/pages/{page_id}', method='PATCH', headers=notion_headers(), body=body)


def notion_set_localid(page_id, localid):
    body = {'properties': {'LocalID': {'rich_text': [{'text': {'content': str(localid)}}]}}}
    _req(f'{NOTION}/pages/{page_id}', method='PATCH', headers=notion_headers(), body=body)


def notion_archive(page_id):
    body = {'archived': True}
    _req(f'{NOTION}/pages/{page_id}', method='PATCH', headers=notion_headers(), body=body)


def _sig(d):
    raw = '\x00'.join('' if d.get(k) is None else str(d.get(k)) for k in FIELDS)
    return hashlib.sha1(raw.encode()).hexdigest()


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f).get('records', {})
    except Exception:
        return {}


def save_state(records):
    with open(STATE_FILE, 'w') as f:
        json.dump({'records': records}, f)


def main():
    stored = load_state()
    locals_ = local_cards()
    pages = notion_pages()

    locals_by_id = {c['id']: c for c in locals_}
    pages_by_localid = {p['localid']: p for p in pages if p['localid']}

    new_stored = {}
    seen_local = set()
    stats = {'n2l_new': 0, 'n2l_upd': 0, 'l2n_upd': 0, 'l2n_new': 0, 'archived': 0}

    # Notion -> Local (Alex edits in Notion)
    for localid, page in pages_by_localid.items():
        if page['archived']:
            continue
        sig = _sig({k: page.get(k) for k in FIELDS})
        new_stored[localid] = sig
        seen_local.add(localid)

        if localid in locals_by_id:
            local_card = locals_by_id[localid]
            local_sig = _sig({k: local_card.get(k, '') for k in FIELDS})
            prev = stored.get(localid)
            if local_sig != sig and prev == sig:
                # Notion changed, local stale
                local_update(localid, page)
                stats['n2l_upd'] += 1
            elif local_sig != sig and prev != local_sig:
                # Conflict: Notion wins
                local_update(localid, page)
                stats['n2l_upd'] += 1
        else:
            # New card from Alex - insert local + backfill LocalID on Notion
            new_card = {k: page.get(k, '') for k in FIELDS}
            res = local_create(new_card)
            cid = res[0] if res else None
            if cid:
                notion_set_localid(page['page_id'], cid)
                stats['n2l_new'] += 1

    # Local -> Notion (Jarvis/team edits in dashboard)
    for cid, card in locals_by_id.items():
        sig = _sig({k: card.get(k, '') for k in FIELDS})
        new_stored[cid] = sig
        if cid in pages_by_localid:
            page = pages_by_localid[cid]
            page_sig = _sig({k: page.get(k) for k in FIELDS})
            prev = stored.get(cid)
            if page_sig != sig and prev == page_sig:
                # Local changed, Notion stale
                notion_update(page['page_id'], card)
                stats['l2n_upd'] += 1
            elif page_sig != sig and prev != sig:
                # Conflict: Notion wins - rewrite local from Notion
                local_update(cid, page)
                stats['n2l_upd'] += 1
        else:
            # New card from me - create Notion page
            page_id = notion_create(card)
            if page_id:
                notion_set_localid(page_id, cid)
                stats['l2n_new'] += 1

    # Archive removed local cards
    for localid in list(stored.keys()):
        if localid not in seen_local and localid not in locals_by_id:
            page = pages_by_localid.get(localid)
            if page and not page['archived']:
                notion_archive(page['page_id'])
                stats['archived'] += 1
            new_stored.pop(localid, None)

    save_state(new_stored)
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
