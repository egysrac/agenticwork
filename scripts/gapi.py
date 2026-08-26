#!/usr/bin/env python3
"""Google API CLI (stdlib-only): Gmail + Calendar.

Auth: OAuth2 refresh_token grant from store/.google-oauth.json.
CLI:
  whoami                                -- openid userinfo (email)
  gmail-list [--query Q] [--max N]      -- Gmail messages with metadata
  gmail-get <id>                        -- single message + headers
  gmail-trash <id>                      -- move one message to Trash
  gmail-trash-query <query>             -- bulk-trash by search query
  gmail-label-query <query> <label>     -- bulk-apply label
  cal-list [--from ISO] [--to ISO]      -- primary calendar events
  cal-create <json-or-stdin->           -- create primary calendar event

Visszaallitva 2026-08-09 a scripts/__pycache__/gapi.cpython-311.pyc alapjan
(mivel a .py fajl torolve volt, csak a pycache maradt), Alex kerte 787661e1.
"""
import sys
import os
import json
import urllib.parse
import urllib.request
import urllib.error

STORE = os.path.join(os.path.dirname(__file__), '..', 'store')
TOKEN_FILE = os.path.join(STORE, '.google-oauth.json')


# ---------- auth ----------

def _access_token():
    """Return a fresh access_token using the stored refresh_token grant.

    A token_uri POST-ot kuld grant_type=refresh_token + client_id +
    client_secret + refresh_token testbol, a valasz access_token-jet
    visszairja a fajlba (obtained_at + access_token + expires_in),
    hogy kovetkezo hivas ne kelljen ujra frissitenie.
    """
    with open(TOKEN_FILE) as f:
        creds = json.load(f)
    data = urllib.parse.urlencode({
        'client_id': creds['client_id'],
        'client_secret': creds['client_secret'],
        'refresh_token': creds['refresh_token'],
        'grant_type': 'refresh_token',
    }).encode('utf-8')
    req = urllib.request.Request(creds['token_uri'], data=data, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode('utf-8'))
    if 'access_token' not in body:
        raise RuntimeError(f"refresh failed: {body}")
    creds['access_token'] = body['access_token']
    creds['expires_in'] = body.get('expires_in')
    creds['obtained_at'] = int(os.environ.get('EPOCHSECONDS', __import__('time').time()))
    try:
        with open(TOKEN_FILE, 'w') as f:
            json.dump(creds, f, indent=2)
    except OSError as e:
        # Nem blokkolo, csak figyelmeztetes -- a memoriaban levo token meg jo erre a hivasra.
        print(f"[warn] access_token write-back failed: {e}", file=sys.stderr)
    return creds['access_token']


# ---------- HTTP helper ----------

def _hdr(headers, name):
    """Case-insensitive header lookup (Gmail API headers mixed-case)."""
    name = name.lower()
    for h in headers:
        if h.get('name', '').lower() == name:
            return h.get('value', '')
    return ''


def _api(method, url, body=None, token=None):
    """Authenticated Google API hivas. body=None eseten GET, kulonben POST JSON."""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if token is None:
        token = _access_token()
    headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            if not raw:
                return {}
            return json.loads(raw.decode('utf-8'))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        print(f"HTTP {e.code}: {body_text}", file=sys.stderr)
        raise SystemExit(1)


# ---------- Gmail ----------

def gmail_list(query='', max_results=50):
    """List Gmail messages matching query, with From/Subject/Date/snippet/labels."""
    params = []
    if query:
        params.append(('q', query))
    params.append(('maxResults', str(max_results)))
    url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?' + urllib.parse.urlencode(params)
    resp = _api('GET', url)
    out = []
    for m in resp.get('messages', []):
        meta_url = (
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/'
            f"{m['id']}?format=metadata"
            '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'
        )
        meta = _api('GET', meta_url)
        headers = meta.get('payload', {}).get('headers', [])
        out.append({
            'id': meta.get('id'),
            'From': _hdr(headers, 'From'),
            'Subject': _hdr(headers, 'Subject'),
            'Date': _hdr(headers, 'Date'),
            'snippet': meta.get('snippet', ''),
            'labelIds': meta.get('labelIds', []),
        })
    return out


def gmail_get(msg_id):
    """Single message metadata + From/To/Subject/Date."""
    url = (
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/'
        f"{msg_id}?format=metadata"
        '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To'
    )
    meta = _api('GET', url)
    headers = meta.get('payload', {}).get('headers', [])
    return {
        'id': meta.get('id'),
        'threadId': meta.get('threadId'),
        'From': _hdr(headers, 'From'),
        'To': _hdr(headers, 'To'),
        'Subject': _hdr(headers, 'Subject'),
        'Date': _hdr(headers, 'Date'),
        'snippet': meta.get('snippet', ''),
        'labelIds': meta.get('labelIds', []),
    }


def gmail_trash(msg_id):
    """Move one message to Trash."""
    url = f'https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}/trash'
    _api('POST', url)
    return {'trashed': msg_id}


def _list_ids(query):
    """All message ids matching a Gmail search query (paginated)."""
    out = []
    page_token = None
    while True:
        params = [('q', query)]
        if page_token:
            params.append(('pageToken', page_token))
        url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?' + urllib.parse.urlencode(params)
        resp = _api('GET', url)
        out.extend([m['id'] for m in resp.get('messages', [])])
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return out


def _batch_modify(ids, add=None, remove=None):
    """Add/remove labels on many messages. batchModify returns an empty 204 body."""
    add = add or []
    remove = remove or []
    url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify'
    token = _access_token()
    for i in range(0, len(ids), 1000):
        chunk = ids[i:i + 1000]
        body = {'ids': chunk, 'addLabelIds': add, 'removeLabelIds': remove}
        data = json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
        except urllib.error.HTTPError as e:
            body_text = e.read().decode('utf-8', errors='replace')
            print(f"HTTP {e.code}: {body_text}", file=sys.stderr)
            raise SystemExit(1)


def gmail_ensure_label(name):
    """Return the id of label `name`, creating it if missing."""
    resp = _api('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/labels')
    for lbl in resp.get('labels', []):
        if lbl.get('name') == name:
            return lbl['id']
    created = _api('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
                   body={'name': name, 'labelListVisibility': 'labelShow'})
    return created['id']


def gmail_trash_query(query):
    """Move every message matching a query to Trash. Returns count."""
    ids = _list_ids(query)
    if not ids:
        return {'trashed_count': 0}
    _batch_modify(ids, add=['TRASH'], remove=['INBOX'])
    return {'trashed_count': len(ids)}


def gmail_label_query(query, label):
    """Apply a label to every message matching a query. Returns count."""
    label_id = gmail_ensure_label(label)
    ids = _list_ids(query)
    if not ids:
        return {'labeled_count': 0, 'label_id': label_id}
    _batch_modify(ids, add=[label_id])
    return {'labeled_count': len(ids), 'label_id': label_id}


# ---------- Calendar ----------

def cal_list(time_min=None, time_max=None, max_results=50):
    """Primary calendar events between timeMin/timeMax (RFC3339)."""
    params = [('singleEvents', 'true'), ('maxResults', str(max_results))]
    if time_min:
        params.append(('timeMin', time_min))
    if time_max:
        params.append(('timeMax', time_max))
    url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + urllib.parse.urlencode(params)
    resp = _api('GET', url)
    out = []
    for ev in resp.get('items', []):
        start = ev.get('start', {})
        end = ev.get('end', {})
        out.append({
            'id': ev.get('id'),
            'summary': ev.get('summary', ''),
            'location': ev.get('location', ''),
            'start': start.get('dateTime') or start.get('date'),
            'end': end.get('dateTime') or end.get('date'),
        })
    return out


def cal_create(event_json):
    """Create a primary calendar event. event_json = dict vagy JSON string."""
    if isinstance(event_json, str):
        event = json.loads(event_json)
    else:
        event = event_json
    resp = _api('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
                body=event)
    return {'id': resp.get('id'), 'htmlLink': resp.get('htmlLink')}


# ---------- CLI ----------

def _opt(args, name):
    if f'--{name}' in args:
        i = args.index(f'--{name}')
        return args[i + 1]
    prefix = f'--{name}='
    for a in args:
        if a.startswith(prefix):
            return a[len(prefix):]
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd == 'whoami':
        info = _api('GET', 'https://openidconnect.googleapis.com/v1/userinfo')
        print(json.dumps({'email': info.get('email')}, indent=2, ensure_ascii=False))

    elif cmd == 'gmail-list':
        query = _opt(args, 'query') or 'newer_than:1d -in:trash -in:sent'
        max_n = int(_opt(args, 'max') or '50')
        out = gmail_list(query, max_n)
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'gmail-get':
        if not args:
            print('gmail-get requires message id', file=sys.stderr)
            raise SystemExit(2)
        out = gmail_get(args[0])
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'gmail-trash':
        if not args:
            print('gmail-trash requires message id', file=sys.stderr)
            raise SystemExit(2)
        out = gmail_trash(args[0])
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'gmail-trash-query':
        if not args:
            print('gmail-trash-query requires query string', file=sys.stderr)
            raise SystemExit(2)
        out = gmail_trash_query(args[0])
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'gmail-label-query':
        if len(args) < 2:
            print('gmail-label-query requires <query> <label>', file=sys.stderr)
            raise SystemExit(2)
        out = gmail_label_query(args[0], args[1])
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'cal-list':
        time_min = _opt(args, 'from')
        time_max = _opt(args, 'to')
        out = cal_list(time_min, time_max)
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'cal-create':
        if not args:
            event_json = sys.stdin.read()
        else:
            arg = args[0]
            if arg == '-':
                event_json = sys.stdin.read()
            elif os.path.exists(arg):
                with open(arg) as f:
                    event_json = f.read()
            else:
                event_json = arg
        out = cal_create(event_json)
        print(json.dumps(out, indent=2, ensure_ascii=False))

    else:
        print(f'unknown command: {cmd}\n', file=sys.stderr)
        raise SystemExit(2)


if __name__ == '__main__':
    main()
