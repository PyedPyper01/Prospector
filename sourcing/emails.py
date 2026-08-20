#!/usr/bin/env python3
"""
Find email addresses by reading each firm's own website. Free — no API, no per-lookup cost.

Google Maps carries the phone but never the email, so this is the only way to get one without paying a
guessing service. It reads the homepage and the usual contact pages, takes published addresses, and prefers
one on the firm's own domain.

    python3 emails.py "Florists"            # whole trade
    python3 emails.py "Florists" CO CM      # just these areas

Writes back with kb's `patch`, which touches only the email column — `upsert` would blank the website and
phone on the same row.
"""
import json, re, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
PAGES = ["", "/contact", "/contact-us", "/about", "/about-us", "/contact.html"]
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

# Addresses that belong to the website's plumbing, not the business.
JUNK = re.compile(r"(sentry|wix|squarespace|godaddy|shopify|cloudflare|example|yourdomain|domain\.com"
                  r"|sample|test@|no-?reply|do-?not-?reply|@2x|\.png|\.jpg|\.gif|\.webp|\.svg"
                  r"|jquery|bootstrap|googleapis|gstatic|w3\.org|schema\.org|\.js$|\.css$)", re.I)
ROLE_PREF = ["info@", "enquiries@", "enquiry@", "hello@", "sales@", "contact@", "office@", "admin@", "mail@"]
# A firm legitimately using a free mailbox is common and fine; an address on some OTHER company's domain is
# almost always the web designer's credit in the footer. Ivy Blossom Florals came back as info@ndiscovered.com
# that way. So: accept the firm's own domain, or a consumer provider, and nothing else.
FREE_MAIL = {"gmail.com","googlemail.com","hotmail.com","hotmail.co.uk","outlook.com","outlook.co.uk",
             "yahoo.com","yahoo.co.uk","ymail.com","btinternet.com","btconnect.com","aol.com","aol.co.uk",
             "live.co.uk","live.com","icloud.com","me.com","mac.com","msn.com","sky.com","talktalk.net",
             "virginmedia.com","protonmail.com","proton.me","tiscali.co.uk","blueyonder.co.uk","ntlworld.com"}

def kb(payload, timeout=180):
    r = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=timeout) as x:
        return json.loads(x.read())

def fetch(url, ms=12):
    try:
        r = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; AfterLifeSupplierBot/1.0; +https://afterlife.ltd)"})
        with urllib.request.urlopen(r, timeout=ms) as x:
            ctype = x.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype: return ""
            return x.read(400_000).decode("utf-8", "ignore")
    except Exception:
        return ""

def domain(url):
    m = re.search(r"https?://(?:www\.)?([^/?#]+)", url or "")
    return (m.group(1) if m else "").lower()

def pick(cands, dom):
    """Prefer a role address on the firm's own domain, then anything on its domain, then anything left."""
    cands = [c.strip(".,;:'\"()<>").lower() for c in cands]
    cands = [c for c in dict.fromkeys(cands) if not JUNK.search(c) and len(c) < 80]
    if not cands: return None
    base = dom.split(".")[0] if dom else ""
    own  = [c for c in cands if base and base in c.split("@")[-1]]
    free = [c for c in cands if c.split("@")[-1] in FREE_MAIL]
    for pool in (own, free):
        for pref in ROLE_PREF:
            for c in pool:
                if c.startswith(pref): return c
        if pool: return pool[0]
    return None          # on somebody else's company domain — that is their web designer, not the firm

def find_email(row):
    site = (row.get("website") or "").strip().rstrip("/")
    if not site: return None
    dom = domain(site)
    for path in PAGES:
        html = fetch(site + path)
        if not html: continue
        hits = EMAIL.findall(html) + [m for m in re.findall(r"mailto:([^\"'?>\s]+)", html, re.I)]
        got = pick(hits, dom)
        if got: return got
    return None

def run(trade, areas):
    rows, off = [], 0
    while True:
        d = kb({"action": "get", "trade": trade, "limit": 1000, "offset": off})
        got = d.get("results") or []
        rows += got
        if len(got) < 1000: break
        off += 1000
    todo = [r for r in rows
            if (r.get("website") or "").strip()
            and not (r.get("email") or "").strip()
            and (not areas or r.get("area") in areas)]
    print(f"{trade}: {len(rows)} rows, {len(todo)} need an email")
    if not todo: return
    found, done = [], 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for row, em in zip(todo, ex.map(find_email, todo)):
            done += 1
            if em: found.append({"name": row["name"], "area": row["area"], "email": em})
            if done % 100 == 0:
                print(f"   {done}/{len(todo)} crawled, {len(found)} emails")
    print(f"   crawled {done}, found {len(found)} ({100*len(found)//max(1,done)}%)")
    for i in range(0, len(found), 100):
        print("   ", json.dumps(kb({"action": "patch", "rows": found[i:i+100]}))[:90])

if __name__ == "__main__":
    run(sys.argv[1], set(a.upper() for a in sys.argv[2:]))
