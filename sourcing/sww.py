#!/usr/bin/env python3
"""
Source will writers from the Society of Will Writers' own member directory.

Same reasoning as ipw.py: every listing is a will writer by definition and membership is the credential.
The Society is the bigger body — 1,376 listings — and its directory is a WordPress site whose archive page
links every member, with each member's page carrying the company name, address, postcode, phone,
website, an obfuscated email, and the postcode areas they say they cover.

Roughly ten minutes end to end at a polite pace; it is a trade body's website, not an API.

    python3 sww.py            # report, save a CSV, write nothing
    python3 sww.py --apply    # write to the store
"""
import csv, html, json, os, re, sys, time, urllib.request

APPLY = "--apply" in sys.argv
KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TRADE = "Will writers & LPA drafters"
EW = set(("AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DE DH DL DN DT DY E EC EN EX FY GL GU "
          "HA HD HG HP HR HU IG IP KT L LA LD LE LL LN LS LU M ME MK N NE NG NN NP NR NW OL OX PE PL PO PR RG "
          "RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS "
          "WV YO").split())
PC = re.compile(r"\b([A-Z]{1,2})\d[A-Z\d]?\s*\d[A-Z]{2}\b")
SOCIETY_OWN_POSTCODE = "LN6 3LQ"      # the Society's Lincoln office, in every page footer
BADGE_HOSTS = re.compile(r"willwriters\.com|vimeo|youtube|facebook|twitter|x\.com|linkedin|instagram|fsb\.org|what3words|google|gstatic|w3\.org|wp\.org|gravatar|schema\.org|trustpilot|checkatrade|yell\.com", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:
            if attempt == 2:
                print(f"  gave up on {url}: {e}")
                return ""
            time.sleep(3)


def kb(payload):
    req = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def cf_decode(hexstr):
    """Cloudflare's email obfuscation: first byte is the key, the rest XOR it."""
    try:
        b = bytes.fromhex(hexstr)
        return bytes(x ^ b[0] for x in b[1:]).decode("utf-8")
    except Exception:
        return ""


def clean(x):
    return re.sub(r"\s+", " ", html.unescape(x or "")).strip()


def parse(page, url):
    og = re.search(r'property="og:description" content="([^"]*)"', page)
    # The description is "Company: X Location / Address: Y Postcode(s) Covered: Z <nbsp> <blurb>". The
    # non-breaking space is the only boundary between the covered areas and the blurb, so split on it
    # BEFORE collapsing whitespace.
    # Non-breaking spaces appear after the labels too, so mark them, collapse everything else, and cut the
    # blurb at the first marker AFTER the covered-areas label.
    raw = html.unescape(og.group(1)).replace("\xa0", "¦") if og else ""
    raw = re.sub(r"\s+", " ", raw).strip()
    m = re.search(r"Company:\s*¦?\s*(.*?)\s*¦?\s*Location / Address:\s*¦?\s*(.*?)\s*¦?\s*Postcode\(s\) Covered:\s*¦?\s*(.*?)\s*(?:¦\s*(.*))?$", raw)
    company = address = covered = None
    blurb = ""
    if m:
        company, address, covered = (m.group(1),), (m.group(2),), (m.group(3),)
        blurb = (m.group(4) or "").replace("¦", " ").strip()
    company = company and re.match(r"(.*)", company[0]); address = address and re.match(r"(.*)", address[0]); covered = covered and re.match(r"(.*)", covered[0])
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    h1text = clean(re.sub(r"<[^>]+>", " ", h1.group(1))) if h1 else ""
    person = clean(re.sub(r"\(.*", "", h1text))
    name = clean(company.group(1)) if company else h1text
    addr = clean(address.group(1)) if address else ""
    body = page[: page.find("footer")] if "footer" in page else page
    pcs = [m for m in PC.finditer(addr or body) if m.group(0).upper() != SOCIETY_OWN_POSTCODE]
    pc = pcs[0].group(0).upper() if pcs else ""
    area = pcs[0].group(1).upper() if pcs else ""
    site = ""
    m = re.search(r'contact_website"[^>]*>\s*<a href="([^"]+)"', page)
    if m and not BADGE_HOSTS.search(m.group(1)):
        site = m.group(1).strip()
    tel = re.search(r'href="tel:([^"]+)"', page)
    phone = clean(tel.group(1)).replace("+0", "0") if tel else ""
    em = ""
    for hexstr in re.findall(r'data-cfemail="([0-9a-f]+)"', page):
        em = cf_decode(hexstr)
        if em and "willwriters.com" not in em:
            break
        em = ""
    return {
        "name": name[:300] or person[:300],
        "trade": TRADE,
        "area": area,
        "district": pc.split(" ")[0] if " " in pc else pc[:-3] if pc else "",
        "postcode": pc,
        "address": addr[:300],
        "website": site,
        "phone": phone,
        "email": em.lower(),
        "source": "sww",
        "source_list": "Society of Will Writers member directory",
        "independence": "SWW member",
        "notes": ("SWW member" + (f" · contact: {person}" if person and person.lower() not in name.lower() else "")
                  + (f" · covers: {clean(covered.group(1))}" if covered else "")
                  + (f" · profile: {blurb[:500]}" if blurb else "") + f" · {url}"),
        "last_verified": time.strftime("%Y-%m-%d"),
    }


def main():
    archive = fetch("https://www.willwriters.com/listing/")
    links = sorted(set(re.findall(r'href="(https://www\.willwriters\.com/listing/[^"/]+/)"', archive)))
    if not links:
        sys.exit("could not read the member list from the archive page")
    print(f"Society of Will Writers lists {len(links)} member(s). Reading each page…")

    rows, skipped = [], []
    for i, url in enumerate(links, 1):
        page = fetch(url)
        if not page:
            skipped.append((url, "unreadable"))
            continue
        r = parse(page, url)
        if not r["name"]:
            skipped.append((url, "no name"))
            continue
        if r["area"] not in EW:
            skipped.append((r["name"], r["postcode"] or "no postcode"))
            continue
        rows.append(r)
        if i % 100 == 0:
            print(f"  {i}/{len(links)} · {len(rows)} usable so far")
        time.sleep(0.35)

    with_site = sum(1 for r in rows if r["website"])
    with_phone = sum(1 for r in rows if r["phone"])
    with_email = sum(1 for r in rows if r["email"])
    print(f"\n{len(rows)} will writers in England & Wales — {with_site} with a website, {with_phone} with a phone, "
          f"{with_email} with an email. {len(skipped)} skipped (outside England & Wales, no postcode, or unreadable).")
    by_area = {}
    for r in rows:
        by_area[r["area"]] = by_area.get(r["area"], 0) + 1
    print("areas covered:", len(by_area))

    out = os.path.join(os.path.expanduser("~/Desktop"), f"SWW_will_writers_{time.strftime('%Y-%m-%d')}.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"Saved to {out}")
    if skipped:
        print("first skipped:", skipped[:5])

    if not APPLY:
        print("\nNothing written to the store. Re-run with --apply to add them.")
        return
    written = 0
    for i in range(0, len(rows), 100):
        d = kb({"action": "merge", "rows": rows[i:i + 100]})
        if not d.get("ok"):
            sys.exit("store refused a batch — stopping: " + json.dumps(d)[:300])
        written += d.get("merged", 0)
        print(f"  stored {written}/{len(rows)}")
    print(f"\nDone. {written} SWW will writers are in the store as {TRADE!r}.")


if __name__ == "__main__":
    main()
