#!/usr/bin/env python3
"""Reddit CLI (stdlib-only): olvasás + posztolás + komment.

Auth: OAuth2 password grant (script-type app). Access tokent 1h-ig cache-eli
lokálisan a /tmp alatt, hogy ne kelljen minden hívásnál újra bejelentkezni.

Creds: store/.vault.json 'reddit' szekció:
  client_id, client_secret, username, password, user_agent (opcionális)

Reddit API base: https://oauth.reddit.com (bejelentkezett hívások), vagy
https://www.reddit.com (publikus, read-only -- jelenleg nem használjuk).

Reddit "fullname" prefixek:
  t1_  comment
  t2_  user/account
  t3_  link/submission
  t4_  message
  t5_  subreddit
  t6_  award
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

VAULT = os.path.expanduser("~/marveen/store/.vault.json")
TOKEN_CACHE = "/tmp/.reddit-token.json"
USER_AGENT_DEFAULT = "jarvis:reddit-cli:v1.0 (by /u/"


# ---------- creds / oauth ----------

def _creds():
    try:
        with open(VAULT, encoding="utf-8") as f:
            d = json.load(f)
        return d.get("reddit") or {}
    except Exception as exc:
        raise SystemExit(f"vault read hiba ({VAULT}): {exc}")


def _basic_token(client_id, client_secret):
    import base64
    raw = f"{client_id}:{client_secret}".encode()
    return base64.b64encode(raw).decode()


def _post_form(url, form, headers):
    body = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(
        url, data=body, headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _get_json(url, token, user_agent):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "User-Agent": user_agent,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _post_json(url, token, user_agent, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "User-Agent": user_agent,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _load_cached_token():
    try:
        with open(TOKEN_CACHE, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("expires_at", 0) > time.time() + 30:
            return data.get("access_token")
    except Exception:
        return None
    return None


def _save_cached_token(token, expires_in):
    try:
        with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
            json.dump(
                {"access_token": token, "expires_at": time.time() + expires_in},
                f,
            )
        try:
            os.chmod(TOKEN_CACHE, 0o600)
        except Exception:
            pass
    except Exception:
        pass


def get_token(force_refresh=False):
    """Reddit OAuth2 access_token. 1h-ig cache-eli /tmp/.reddit-token.json-ban."""
    if not force_refresh:
        cached = _load_cached_token()
        if cached:
            return cached

    c = _creds()
    client_id = c.get("client_id")
    client_secret = c.get("client_secret")
    username = c.get("username")
    password = c.get("password")
    if not all([client_id, client_secret, username, password]):
        raise SystemExit(
            "reddit credentials hianyosak a vault-ban "
            "(client_id, client_secret, username, password kellenek)"
        )

    auth = _basic_token(client_id, client_secret)
    try:
        data = _post_form(
            "https://www.reddit.com/api/v1/access_token",
            {
                "grant_type": "password",
                "username": username,
                "password": password,
            },
            {
                "Authorization": "Basic " + auth,
                "User-Agent": c.get("user_agent") or USER_AGENT_DEFAULT + str(username),
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode()[:300]
        except Exception:
            pass
        raise SystemExit(f"oauth hiba: {exc.code} {exc.reason} {body}")
    except Exception as exc:
        raise SystemExit(f"oauth hiba: {type(exc).__name__}: {exc}")

    token = data.get("access_token")
    expires_in = int(data.get("expires_in", 3600))
    if not token:
        raise SystemExit(f"oauth hiba: nincs access_token a válaszban: {data}")
    _save_cached_token(token, expires_in)
    return token


def ua():
    c = _creds()
    return c.get("user_agent") or USER_AGENT_DEFAULT + str(c.get("username", "anon"))


# ---------- API helpers ----------

def _kind(fullname):
    """t1_=comment, t2_=account, t3_=link, t5_=subreddit -- at least 4 chars."""
    if not fullname or len(fullname) < 4:
        return None
    return fullname[:3]


def _listing_url(kind):
    base = "https://oauth.reddit.com"
    if kind == "subreddit":
        return lambda sub, sort, limit, t: (
            f"{base}/r/{sub}/{sort}?limit={limit}&t={t}"
        )
    if kind == "user":
        return lambda name, sort, limit, t: (
            f"{base}/user/{name}/submitted?sort={sort}&limit={limit}&t={t}"
        )
    return None


def cmd_auth():
    """Lekéri + kiírja a token lejáratát. Ha a vault hiányos, hibát jelez."""
    token = get_token(force_refresh=True)
    print(json.dumps({
        "ok": True,
        "token_len": len(token),
        "expires_in_s": 3600,
        "token_preview": token[:10] + "...",
    }, indent=2))


def cmd_me():
    token = get_token()
    data = _get_json("https://oauth.reddit.com/api/v1/me", token, ua())
    print(json.dumps({
        "name": data.get("name"),
        "id": data.get("id"),
        "link_karma": data.get("link_karma"),
        "comment_karma": data.get("comment_karma"),
        "created_utc": data.get("created_utc"),
        "subreddit": (data.get("subreddit") or {}).get("display_name"),
    }, indent=2, ensure_ascii=False))


def cmd_list(subreddit, sort="new", limit=25, t="all"):
    token = get_token()
    sort = sort if sort in ("new", "hot", "top", "rising", "controversial") else "new"
    t = t if t in ("hour", "day", "week", "month", "year", "all") else "all"
    limit = max(1, min(int(limit), 100))

    url = (
        f"https://oauth.reddit.com/r/{urllib.parse.quote(subreddit)}/{sort}"
        f"?limit={limit}&t={t}"
    )
    data = _get_json(url, token, ua())
    children = (data.get("data") or {}).get("children") or []
    rows = []
    for c in children:
        d = c.get("data") or {}
        rows.append({
            "fullname": d.get("name"),
            "id": d.get("id"),
            "title": d.get("title"),
            "author": d.get("author"),
            "subreddit": d.get("subreddit"),
            "score": d.get("score"),
            "num_comments": d.get("num_comments"),
            "url": "https://redd.it/" + d.get("id", ""),
            "permalink": "https://reddit.com" + (d.get("permalink") or ""),
            "created_utc": d.get("created_utc"),
            "selftext": (d.get("selftext") or "")[:500],
        })
    print(json.dumps(rows, indent=2, ensure_ascii=False))


def cmd_get(fullname_or_url):
    """Lekérdez egy submissiont vagy commentet. Fullname vagy url alapján."""
    token = get_token()
    if fullname_or_url.startswith("t1_") or fullname_or_url.startswith("t3_"):
        kind = _kind(fullname_or_url)
        if kind == "t3":
            url = f"https://oauth.reddit.com/api/info?id={fullname_or_url}"
        else:
            url = (
                f"https://oauth.reddit.com/api/info?"
                f"id={fullname_or_url}"
            )
    elif "reddit.com" in fullname_or_url or "redd.it" in fullname_or_url:
        # comment permalinkből /r/.../comments/POST_ID/title/COMMENT_ID
        path = fullname_or_url.split("reddit.com", 1)[-1].split("?", 1)[0]
        url = (
            f"https://oauth.reddit.com{path}.json"
        )
    else:
        raise SystemExit(
            "get: fullname vagy URL kell (pl. t3_1abc vagy "
            "https://www.reddit.com/r/python/comments/.../...)"
        )
    data = _get_json(url, token, ua())
    # api/info válasz: data.children[].data.{...}; a listing.json: [post, comments]
    items = data.get("data", {}).get("children", []) if isinstance(data.get("data"), dict) else None
    if items is None and isinstance(data, list):
        items = data[0].get("data", {}).get("children", []) if data else []
    if not items:
        print(json.dumps({"empty": True, "raw_keys": list(data.keys())}, indent=2))
        return
    print(json.dumps(items[0].get("data"), indent=2, ensure_ascii=False))


def cmd_search(query, subreddit=None, limit=25, sort="relevance", t="all"):
    token = get_token()
    limit = max(1, min(int(limit), 100))
    base = "https://oauth.reddit.com/search"
    if subreddit:
        base = f"https://oauth.reddit.com/r/{urllib.parse.quote(subreddit)}/search"
    params = {
        "q": query,
        "limit": str(limit),
        "sort": sort,
        "t": t,
        "restrict_sr": "on" if subreddit else "off",
    }
    url = base + "?" + urllib.parse.urlencode(params)
    data = _get_json(url, token, ua())
    children = (data.get("data") or {}).get("children") or []
    rows = []
    for c in children:
        d = c.get("data") or {}
        rows.append({
            "fullname": d.get("name"),
            "id": d.get("id"),
            "title": d.get("title"),
            "author": d.get("author"),
            "subreddit": d.get("subreddit"),
            "score": d.get("score"),
            "num_comments": d.get("num_comments"),
            "url": "https://redd.it/" + d.get("id", ""),
            "permalink": "https://reddit.com" + (d.get("permalink") or ""),
        })
    print(json.dumps(rows, indent=2, ensure_ascii=False))


def cmd_post(subreddit, title, body=None, url=None, kind="self"):
    """Új poszt. kind=self:text, kind=link:url megadása kötelező."""
    token = get_token()
    sr = subreddit.lstrip("r/").lstrip("/")
    payload = {
        "sr": sr,
        "title": title,
        "kind": kind,  # "self" (text) vagy "link"
    }
    if kind == "self":
        payload["text"] = body or ""
    elif kind == "link":
        if not url:
            raise SystemExit("link poszthoz --url megadása kötelező")
        payload["url"] = url
    else:
        raise SystemExit("kind csak 'self' vagy 'link' lehet")

    data = _post_json(
        "https://oauth.reddit.com/api/submit", token, ua(), payload,
    )
    # A válasz json.kind lehet "link" vagy "self" -- az elkészült poszt adatai.
    print(json.dumps({
        "ok": True,
        "kind": (data.get("json") or {}).get("data", {}).get("kind") or kind,
        "url": ((data.get("json") or {}).get("data") or {}).get("url"),
        "permalink": ((data.get("json") or {}).get("data") or {}).get("permalink"),
        "id": ((data.get("json") or {}).get("data") or {}).get("id"),
        "errors": (data.get("json") or {}).get("errors") or [],
    }, indent=2, ensure_ascii=False))


def cmd_comment(parent_fullname, body):
    token = get_token()
    payload = {
        "thing_id": parent_fullname,  # t3_xxx (link) vagy t1_xxx (comment)
        "text": body,
    }
    data = _post_json(
        "https://oauth.reddit.com/api/comment", token, ua(), payload,
    )
    print(json.dumps({
        "ok": True,
        "thing_id": (data.get("json") or {}).get("data", {}).get("thing_id"),
        "id": (data.get("json") or {}).get("data", {}).get("id"),
        "errors": (data.get("json") or {}).get("errors") or [],
    }, indent=2, ensure_ascii=False))


# ---------- CLI ----------

def _opt(args, name):
    if f"--{name}" in args:
        i = args.index(f"--{name}")
        return args[i + 1] if i + 1 < len(args) else None
    prefix = f"--{name}="
    for a in args:
        if a.startswith(prefix):
            return a[len(prefix):]
    return None


def _usage():
    print("""reddit.py {auth|me|list|get|search|post|comment} [...]

  reddit.py auth                                                    -- validate creds
  reddit.py me                                                      -- current user
  reddit.py list <subreddit> [--sort new|hot|top] [--limit N] [--t all|day|...]
  reddit.py get <fullname_or_url>                                   -- single post/comment
  reddit.py search <query> [--subreddit NAME] [--limit N] [--sort relevance|...]
  reddit.py post <subreddit> <title> [--body TEXT] [--kind self|link] [--url URL]
  reddit.py comment <t3_xxx|t1_xxx> <body>                         -- reply
""", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        _usage(); sys.exit(2)
    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd == "auth":
        cmd_auth()
    elif cmd == "me":
        cmd_me()
    elif cmd == "list":
        sub = args[0] if args else None
        if not sub:
            print("list: subreddit kell"); sys.exit(2)
        cmd_list(
            sub,
            sort=_opt(args, "sort") or "new",
            limit=int(_opt(args, "limit") or 25),
            t=_opt(args, "t") or "all",
        )
    elif cmd == "get":
        if not args:
            print("get: fullname vagy url kell"); sys.exit(2)
        cmd_get(args[0])
    elif cmd == "search":
        q = args[0] if args else None
        if not q:
            print("search: query kell"); sys.exit(2)
        cmd_search(
            q,
            subreddit=_opt(args, "subreddit"),
            limit=int(_opt(args, "limit") or 25),
            sort=_opt(args, "sort") or "relevance",
            t=_opt(args, "t") or "all",
        )
    elif cmd == "post":
        if len(args) < 2:
            print("post: subreddit és title kell"); sys.exit(2)
        kind = _opt(args, "kind") or "self"
        if kind == "self" and len(args) < 3:
            print("self post: body is kell (--body '...')", file=sys.stderr)
            sys.exit(2)
        if kind == "link":
            url = _opt(args, "url")
            if not url:
                print("link post: --url megadása kötelező", file=sys.stderr)
                sys.exit(2)
        cmd_post(
            args[0], args[1],
            body=_opt(args, "body"),
            url=_opt(args, "url"),
            kind=kind,
        )
    elif cmd == "comment":
        if len(args) < 2:
            print("comment: thing_id és body kell"); sys.exit(2)
        cmd_comment(args[0], args[1])
    elif cmd in ("-h", "--help", "help"):
        _usage()
    else:
        print(f"ismeretlen parancs: {cmd}", file=sys.stderr)
        _usage()
        sys.exit(2)


if __name__ == "__main__":
    main()
