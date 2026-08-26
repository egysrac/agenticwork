#!/usr/bin/env python3
"""iCloud CalDAV CLI (stdlib-only): events / create / list.

Auth: Basic with apple_id + app-specific password.
Discovery: PROPFIND root + principal + calendar-home-set.

Visszaallitva 2026-08-08 a __pycache__/icaldav.cpython-311.pyc alapjan (Alex kerte,
a scripts/icaldav.py torolve volt, csak a pycache maradt).
"""
import sys
import os
import json
import uuid
import base64
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

NS_DAV = "DAV:"
NS_CAL = "urn:ietf:params:xml:ns:caldav"
NS_APPLE = "http://apple.com/ns/ical/"

CREDS_FILE = os.path.expanduser("~/marveen/store/.apple-caldav.json")
SCHEME_HOST = "https://caldav.icloud.com"


# ---------- creds / dav primitives ----------

def _creds():
    with open(CREDS_FILE) as f:
        c = json.load(f)
    return c["apple_id"], c["app_specific_password"]


def _dav(method, url, user, pw, body=None, depth=None, content_type=None):
    headers = {}
    if depth is not None:
        headers["Depth"] = depth
    if body is not None:
        if isinstance(body, str):
            body = body.encode("utf-8")
        if content_type is None:
            # Auto-detect: iCalendar body -> text/calendar, különben XML
            if body.lstrip().startswith(b"BEGIN:VCALENDAR"):
                content_type = "text/calendar; charset=utf-8"
            else:
                content_type = "text/xml; charset=utf-8"
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    token = base64.b64encode(f"{user}:{pw}".encode("utf-8")).decode("ascii")
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            try:
                return r.status, ET.fromstring(data)
            except ET.ParseError:
                return r.status, data
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


# ---------- discovery ----------

def discover(user, pw):
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<d:propfind xmlns:d="DAV:">'
        b"<d:prop><d:current-user-principal/></d:prop>"
        b"</d:propfind>"
    )
    status, resp = _dav("PROPFIND", f"{SCHEME_HOST}/", user, pw, body=body, depth="0")
    if status != 207:
        raise RuntimeError(f"discover failed: {status} {resp}")
    ns = {"d": NS_DAV}
    href = resp.find(".//d:current-user-principal/d:href", ns)
    if href is None or not href.text:
        raise RuntimeError("no current-user-principal in discover response")
    return SCHEME_HOST + href.text


def _abs_url(maybe_relative):
    """Resolve a href from PROPFIND: teljes URL ha abszolút, különben SCHEME_HOST prefix."""
    if not maybe_relative:
        return SCHEME_HOST + "/"
    if maybe_relative.startswith(("http://", "https://")):
        return maybe_relative
    return SCHEME_HOST + maybe_relative


def _calendar_home(user, pw, principal_url):
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b"<d:prop><c:calendar-home-set/></d:prop>"
        b"</d:propfind>"
    )
    status, resp = _dav("PROPFIND", principal_url, user, pw, body=body, depth="0")
    if status != 207:
        raise RuntimeError(f"calendar-home-set failed: {status} {resp}")
    ns = {"d": NS_DAV, "c": NS_CAL}
    href = resp.find(".//c:calendar-home-set/d:href", ns)
    if href is None or not href.text:
        raise RuntimeError("no calendar-home-set in response")
    return _abs_url(href.text)


def list_calendars(user, pw, home_url):
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">'
        b"<d:prop><d:displayname/><c:supported-calendar-component-set/><d:resourcetype/><cs:getctag/></d:prop>"
        b"</d:propfind>"
    )
    status, resp = _dav("PROPFIND", home_url, user, pw, body=body, depth="1")
    if status != 207:
        raise RuntimeError(f"list_calendars failed: {status} {resp}")
    ns = {"d": NS_DAV, "c": NS_CAL}
    out = []
    for r in resp.findall(".//d:response", ns):
        href_el = r.find("d:href", ns)
        if href_el is None:
            continue
        href = href_el.text
        if r.find(".//d:resourcetype/c:calendar", ns) is None:
            continue
        dn = r.find(".//d:displayname", ns)
        name = dn.text if (dn is not None and dn.text) else os.path.basename(href.rstrip("/"))
        ctag = r.find(".//{http://calendarserver.org/ns/}getctag", ns)
        out.append({
            "name": name,
            "href": href,
            "url": _abs_url(href),
            "ctag": ctag.text if (ctag is not None and ctag.text) else None,
        })
    return out


def resolve_calendar(user, pw, cal_name=None):
    principal = discover(user, pw)
    home = _calendar_home(user, pw, principal)
    cals = list_calendars(user, pw, home)
    if cal_name:
        for c in cals:
            if c["name"].lower() == cal_name.lower():
                return c["url"]
    if not cals:
        raise RuntimeError("no calendars found")
    for c in cals:
        if c["name"].lower() in ("home", "személyes", "szemelyes"):
            return c["url"]
    return cals[0]["url"]


# ---------- time / ical helpers ----------

def _to_utc(dt_str):
    if dt_str.endswith("Z"):
        dt_str = dt_str[:-1] + "+00:00"
    dt = datetime.fromisoformat(dt_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _format_ical_dt(dt):
    dt_utc = dt.astimezone(timezone.utc)
    return dt_utc.strftime("%Y%m%dT%H%M%SZ")


def _esc(s):
    if s is None:
        return ""
    return (
        str(s)
        .replace("\\", "\\\\")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("\n", "\\n")
    )


def build_vevent(ev):
    """Build iCalendar text from dict.

    Támogatott mezők:
      uid, summary, start, end (ISO 8601), location, description,
      reminders.overrides[].minutes (VALARM)
    """
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//marveen//icaldav.py//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
    ]
    uid = ev.get("uid") or str(uuid.uuid4())
    lines.append(f"UID:{uid}")
    lines.append(f"DTSTAMP:{_format_ical_dt(datetime.now(timezone.utc))}")

    if "start" in ev:
        s = ev["start"]
        if "T" in s:
            lines.append(f"DTSTART:{_format_ical_dt(_to_utc(s))}")
        else:
            lines.append(f"DTSTART;VALUE=DATE:{s.replace('-', '')}")
    if "end" in ev:
        e = ev["end"]
        if "T" in e:
            lines.append(f"DTEND:{_format_ical_dt(_to_utc(e))}")
        else:
            lines.append(f"DTEND;VALUE=DATE:{e.replace('-', '')}")

    if ev.get("summary"):
        lines.append(f"SUMMARY:{_esc(ev['summary'])}")
    if ev.get("location"):
        lines.append(f"LOCATION:{_esc(ev['location'])}")
    if ev.get("description"):
        lines.append(f"DESCRIPTION:{_esc(ev['description'])}")

    for rem in ev.get("reminders", {}).get("overrides", []):
        lines.append("BEGIN:VALARM")
        lines.append("ACTION:DISPLAY")
        lines.append(f"DESCRIPTION:{_esc(ev.get('summary', 'Reminder'))}")
        lines.append(f"TRIGGER:-PT{int(rem['minutes'])}M")
        lines.append("END:VALARM")

    lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines)


# ---------- read / write ----------

def read_events(user, pw, cal_url, start_utc, end_utc):
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        "<d:prop><d:getetag/><c:calendar-data/></d:prop>"
        "<c:filter>"
        '<c:comp-filter name="VCALENDAR">'
        '<c:comp-filter name="VEVENT">'
        f'<c:time-range start="{_format_ical_dt(start_utc)}" end="{_format_ical_dt(end_utc)}"/>'
        "</c:comp-filter>"
        "</c:comp-filter>"
        "</c:filter>"
        "</c:calendar-query>"
    )
    status, resp = _dav("REPORT", cal_url, user, pw, body=body, depth="1")
    if status not in (207, 200):
        raise RuntimeError(f"read_events failed: {status} {resp}")
    if not hasattr(resp, "findall"):
        return []
    ns = {"d": NS_DAV, "c": NS_CAL}
    events = []
    for r in resp.findall(".//d:response", ns):
        href_el = r.find("d:href", ns)
        if href_el is None:
            continue
        href = href_el.text
        cd = r.find(".//c:calendar-data", ns)
        if cd is None or not cd.text:
            continue
        events.append({"href": href, "ical": cd.text})
    return events


def _unfold(text):
    """RFC 5545 line unfolding: CRLF + space/tab -> nothing.

    Normalises CRLF -> LF first so the parser also handles servers that
    send plain LF (iCloud CalDAV actually does this for calendar-data
    payloads, instead of the spec-mandated CRLF).
    """
    text = text.replace("\r\n", "\n")
    out = []
    for line in text.split("\n"):
        if line.startswith((" ", "\t")) and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def _parse_ical(text):
    """Minimal iCal -> dict (summary/start/end/location/description)."""
    lines = _unfold(text)
    out = {"summary": "", "start": None, "end": None, "location": "", "description": ""}
    in_event = False
    for line in lines:
        if line == "BEGIN:VEVENT":
            in_event = True
        elif line == "END:VEVENT":
            in_event = False
        elif in_event:
            if line.startswith("SUMMARY:"):
                out["summary"] = line[len("SUMMARY:"):]
            elif line.startswith("DTSTART"):
                v = line.split(":", 1)
                out["start"] = v[1] if len(v) > 1 else ""
            elif line.startswith("DTEND"):
                v = line.split(":", 1)
                out["end"] = v[1] if len(v) > 1 else ""
            elif line.startswith("LOCATION:"):
                out["location"] = line[len("LOCATION:"):]
            elif line.startswith("DESCRIPTION:"):
                out["description"] = line[len("DESCRIPTION:"):]
    return out


# ---------- CLI commands ----------

def cmd_list():
    user, pw = _creds()
    principal = discover(user, pw)
    home = _calendar_home(user, pw, principal)
    cals = list_calendars(user, pw, home)
    print(json.dumps(cals, indent=2, ensure_ascii=False))


def cmd_events(from_iso, to_iso, cal_name=None):
    user, pw = _creds()
    cal_url = resolve_calendar(user, pw, cal_name)
    raw = read_events(user, pw, cal_url, _to_utc(from_iso), _to_utc(to_iso))
    out = []
    for ev in raw:
        out.append(_parse_ical(ev["ical"]))
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_create(body_json, cal_name=None):
    ev = json.loads(body_json)
    user, pw = _creds()
    cal_url = resolve_calendar(user, pw, cal_name)
    ical = build_vevent(ev)
    uid = ev.get("uid") or str(uuid.uuid4())
    event_url = cal_url.rstrip("/") + "/" + uid + ".ics"
    status, resp = _dav("PUT", event_url, user, pw, body=ical)
    if status not in (200, 201, 204):
        raise RuntimeError(f"create failed: {status} {resp}")
    print(json.dumps({"ok": True, "href": event_url, "uid": uid}))


def main():
    if len(sys.argv) < 2:
        print(
            "Usage: icaldav.py {events|create|list} [--cal NAME]",
            file=sys.stderr,
        )
        sys.exit(2)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    def _opt(name):
        # --name value  OR  --name=value
        if f"--{name}" in args:
            i = args.index(f"--{name}")
            return args[i + 1]
        prefix = f"--{name}="
        for a in args:
            if a.startswith(prefix):
                return a[len(prefix):]
        return None

    if cmd == "list":
        cmd_list()
    elif cmd == "events":
        from_iso = _opt("from")
        to_iso = _opt("to")
        cal_name = _opt("cal")
        if not from_iso or not to_iso:
            print("--from and --to required", file=sys.stderr)
            sys.exit(2)
        cmd_events(from_iso, to_iso, cal_name)
    elif cmd == "create":
        if not args:
            print("create requires JSON body arg", file=sys.stderr)
            sys.exit(2)
        body_json = args[0]
        cal_name = _opt("cal")
        cmd_create(body_json, cal_name)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()