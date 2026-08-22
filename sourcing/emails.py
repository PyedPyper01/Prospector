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

# UK numbers, in the shapes businesses actually publish them. Anchored on the leading 0 and the real UK
# groupings so it does not swallow company numbers, VAT numbers, dates or prices.
PHONE = re.compile(r"""(?x)
    (?:\+44\s?|0)
    (?:
        2\d\s?\d{4}\s?\d{4}          # 020 7946 0000
      | 1\d{3}\s?\d{5,6}              # 01206 573222
      | 1\d{2}\s?\d{3}\s?\d{4}        # 0161 832 7731
      | 7\d{3}\s?\d{6}                # 07700 900000
      | 800\s?\d{6}|808\s?\d{7}|845\s?\d{6}|3\d{2}\s?\d{3}\s?\d{4}
    )""")
PHONE_JUNK = re.compile(r"(0800\s?11\s?11|999|101|123456|000000|1234567)")

def clean_phone(raw):
    """Validate, but do NOT re-space. UK area codes run from two to five digits, so imposing a grouping turns
    01344 851250 into 013 4485 1250 and 0161 768 7722 into 01617 687722. The business already formats its own
    number correctly on its website, so keep what it published and only normalise the +44 prefix."""
    digits = re.sub(r"[^\d+]", "", raw or "")
    # "+44 (0)1727 860207" is a very common published form; the bracketed zero survives the strip and would
    # otherwise leave a double leading zero that fails validation.
    if digits.startswith("+44"):
        digits = digits[3:]
        digits = "0" + (digits[1:] if digits.startswith("0") else digits)
    if not digits.startswith("0") or not (10 <= len(digits) <= 11): return None
    if PHONE_JUNK.search(digits): return None
    shown = re.sub(r"\s+", " ", str(raw).strip())
    shown = re.sub(r"^\+44\s*\(?\s*0?\s*\)?\s*", "0", shown)
    # keep the published form when it is the same number, otherwise fall back to bare digits
    return shown if re.sub(r"[^\d]", "", shown) == digits else digits

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

def find_contacts(row):
    """One pass, both fields. The pages are already being fetched for the email, so the phone is free."""
    site = (row.get("website") or "").strip().rstrip("/")
    if not site: return (None, None)
    dom = domain(site)
    want_email = not (row.get("email") or "").strip()
    want_phone = not (row.get("phone") or "").strip()
    email = phone = None
    for path in PAGES:
        if (email or not want_email) and (phone or not want_phone): break
        html = fetch(site + path)
        if not html: continue
        if want_email and not email:
            hits = EMAIL.findall(html) + [m for m in re.findall(r"mailto:([^\"'?>\s]+)", html, re.I)]
            email = pick(hits, dom)
        if want_phone and not phone:
            tel = [t for t in re.findall(r"tel:([+0-9()\s\-]{9,20})", html, re.I)]
            cands = [clean_phone(t) for t in tel] + [clean_phone(m.group(0)) for m in PHONE.finditer(html)]
            phone = next((c for c in cands if c), None)
    return (email, phone)

def run(trade, areas):
    rows, off = [], 0
    while True:
        q = {"action": "get", "limit": 1000, "offset": off}
        if trade: q["trade"] = trade
        d = kb(q)
        got = d.get("results") or []
        rows += got
        if len(got) < 1000: break
        off += 1000
    todo = [r for r in rows
            if (r.get("website") or "").strip()
            and (not (r.get("email") or "").strip() or not (r.get("phone") or "").strip())
            and (not areas or r.get("area") in areas)]
    print(f"{trade or 'ALL TRADES'}: {len(rows)} rows, {len(todo)} missing an email and/or a phone")
    if not todo: return
    found, done, ne, np, written = [], 0, 0, 0, 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for row, (em, ph) in zip(todo, ex.map(find_contacts, todo)):
            done += 1
            patch = {}
            if em and not (row.get("email") or "").strip(): patch["email"] = em; ne += 1
            if ph and not (row.get("phone") or "").strip(): patch["phone"] = ph; np += 1
            if patch: found.append({"name": row["name"], "area": row["area"], **patch})
            # Write in blocks as we go. Holding everything to the end means a run of several hours has
            # nothing in the database until the last moment, and any interruption throws the lot away — the
            # same trap the area sweep had. It also keeps the top-up pricing honest while this is running.
            if len(found) >= 200:
                kb({"action": "patch", "rows": found}); written += len(found); found = []
            if done % 250 == 0:
                print(f"   {done}/{len(todo)} crawled · {ne} emails · {np} phones · {written} written")
    print(f"   crawled {done} · {ne} emails ({100*ne//max(1,done)}%) · {np} phones ({100*np//max(1,done)}%)")
    for i in range(0, len(found), 100):
        kb({"action": "patch", "rows": found[i:i+100]}); written += len(found[i:i+100])
    print(f"   {written} rows updated")

if __name__ == "__main__":
    trade = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "ALL" else None
    run(trade, set(a.upper() for a in sys.argv[2:]))
