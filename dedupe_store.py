#!/usr/bin/env python3
"""
Remove duplicate suppliers from the stored data.

The store's unique key is name+area, so the same firm entered under two spellings — "Dillys" and
"Dillys Bespoke Florist" in CO — is two rows by definition, and nothing has ever removed them.
This finds them, merges each group into its most complete row, and deletes the rest.

It uses the SAME identity rules as the app: two rows in one trade and one postcode area are the same
firm if they share a website domain, a Companies House number, or an email address — or if their core
names match with nothing contradicting it. A website of facebook.com (229 rows have one) identifies
nobody and is never used as a match.

A firm listed in SEVERAL areas is left alone. That is its footprint, not a duplicate: publishing
already sends it as one record carrying every area it covers.

    python3 dedupe_store.py            # report only — writes a CSV of every merge it would make
    python3 dedupe_store.py --apply    # back up first, then merge and delete

Nothing is deleted without --apply, and --apply refuses to run until a full backup has been written.
"""
import csv, json, os, re, subprocess, sys, time, urllib.request

KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
HERE = os.path.dirname(os.path.abspath(__file__))
APPLY = "--apply" in sys.argv

# fields worth carrying from a row that is about to be deleted onto the one that survives
CARRY = ["website", "phone", "email", "postcode", "address", "district", "company_number",
         "description", "independence", "source", "source_list", "last_verified", "notes", "category"]

GENERIC_SITE = re.compile(
    r"(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|twitter\.com|x\.com|t\.co|linkedin\.com|"
    r"youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|nextdoor\.[a-z.]+|linktr\.ee|bit\.ly|wa\.me|"
    r"whatsapp\.com|sites\.google\.com|business\.site|google\.[a-z.]+|goo\.gl|bing\.com|yahoo\.[a-z.]+|"
    r"apple\.com|wixsite\.com|wordpress\.com|blogspot\.[a-z.]+|weebly\.com|squarespace\.com|myshopify\.com|"
    r"yell\.com|yelp\.[a-z.]+|thomsonlocal\.com|freeindex\.co\.uk|cylex-uk\.co\.uk|scoot\.co\.uk|192\.com|"
    r"checkatrade\.com|trustpilot\.com|tripadvisor\.[a-z.]+|gumtree\.com|etsy\.com|ebay\.[a-z.]+|"
    r"amazon\.[a-z.]+|wikipedia\.org|businformaps\.org|companieshouse\.gov\.uk|service\.gov\.uk|gov\.uk|"
    r"unbiased\.co\.uk|vouchedfor\.co\.uk)$", re.I)
GENERIC_MAIL = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "yahoo.com",
                "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "live.com", "live.co.uk", "msn.com",
                "btinternet.com", "btconnect.com", "sky.com", "talktalk.net", "virginmedia.com"}
LEGAL = re.compile(r"\b(ltd|limited|llp|plc|the|co|company|funeral directors?|funerals?|funeralcare|"
                   r"services?|service|group|and|sons?|son)\b")


def post(payload, tries=3):
    for attempt in range(tries):
        try:
            r = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                                       headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(r, timeout=180) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1} after {e}")
            time.sleep(3)


def domain(u):
    if not u:
        return ""
    h = re.sub(r"^https?://", "", str(u).strip().lower())
    h = re.sub(r"^www\.", "", h)
    m = re.match(r"^([a-z0-9.-]+)", h)
    return m.group(1) if m else ""


def site(u):
    """The website domain only when it identifies THIS firm and no other."""
    d = domain(u)
    return "" if GENERIC_SITE.search(d) else d


def name_key(s):
    s = (s or "").lower().replace("&", "and")
    s = re.sub(r"\btrading\s+as\b.*$", "", s)
    s = re.sub(r"\bt\s*/\s*a\b.*$", "", s)
    s = re.sub(r"\s+[-–—]\s+.*$", "", s)
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)
    return re.sub(r"[^a-z0-9]+", "", LEGAL.sub("", s))[:14]


def emails(r):
    raw = (r.get("email") or "")
    return {e.strip().lower() for e in re.split(r"[;,\s]+", raw)
            if re.match(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$", e.strip().lower())}


def ch(r):
    return re.sub(r"\s", "", str(r.get("company_number") or "")).upper()


def completeness(r):
    """Prefer the row that costs most to recreate: a write-up above contact details above nothing."""
    return (2 * bool((r.get("description") or "").strip())
            + 2 * bool(emails(r)) + bool((r.get("phone") or "").strip())
            + bool(site(r.get("website"))) + bool((r.get("postcode") or "").strip())
            + bool((r.get("address") or "").strip()) + bool(ch(r)))


def pull():
    rows, off = [], 0
    expected = post({"action": "stats"}).get("total")
    if not expected:
        sys.exit("could not read the row count from the store")
    print(f"store reports {expected} rows")
    while True:
        d = post({"action": "get", "limit": 1000, "offset": off})
        got = d.get("results") or []
        if not got:
            break
        rows.extend(got)
        off += len(got)
        if len(got) < 1000:
            break
    if len(rows) < expected:
        sys.exit(f"read only {len(rows)} of {expected} rows — refusing to de-duplicate a partial read. Re-run.")
    return rows


def group(rows):
    """Union rows in one trade+area that share a strong identity, then rows sharing a core name."""
    out = []
    buckets = {}
    for r in rows:
        buckets.setdefault((r.get("trade"), (r.get("area") or "").upper()), []).append(r)

    for members in buckets.values():
        if len(members) < 2:
            continue
        parent = {}

        def find(x):
            while parent.get(x, x) != x:
                parent[x] = parent.get(parent[x], parent[x])
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        for r in members:
            parent[r["id"]] = r["id"]
        by = {}
        for r in members:                                    # strong ids: website, company number, email
            for k in (["d:" + site(r.get("website"))] if site(r.get("website")) else []) + \
                     (["c:" + ch(r)] if ch(r) else []) + ["e:" + e for e in emails(r)]:
                if k in by:
                    union(by[k], r["id"])
                else:
                    by[k] = r["id"]

        byid = {r["id"]: r for r in members}
        byname = {}
        for r in members:                                    # then core name, unless something contradicts it
            k = name_key(r.get("name"))
            if len(k) < 6:
                continue
            if k in byname:
                a, b = byid[byname[k]], r
                da, db = site(a.get("website")), site(b.get("website"))
                ca, cb = ch(a), ch(b)
                if (da and db and da != db) or (ca and cb and ca != cb):
                    continue                                  # different websites / companies — leave apart
                union(byname[k], r["id"])
            else:
                byname[k] = r["id"]

        clusters = {}
        for r in members:
            clusters.setdefault(find(r["id"]), []).append(r)
        out.extend(g for g in clusters.values() if len(g) > 1)
    return out


def main():
    rows = pull()
    groups = group(rows)
    if not groups:
        print("\nNo duplicates found — every firm is listed once per trade and postcode area.")
        return

    plan, patches, deletes = [], [], []
    for g in groups:
        keep = max(g, key=completeness)
        fill = {}
        for r in g:
            if r is keep:
                continue
            for f in CARRY:
                if not (keep.get(f) or "").strip() and (r.get(f) or "").strip():
                    fill[f] = r[f]
                    keep[f] = r[f]
            deletes.append({"name": r["name"], "area": r["area"]})
            plan.append({"trade": r.get("trade"), "area": r.get("area"), "deleted": r.get("name"),
                         "kept": keep.get("name"), "kept_website": keep.get("website") or "",
                         "deleted_website": r.get("website") or "",
                         "fields_moved_to_the_kept_row": "; ".join(sorted(fill)) or "(none)"})
        if fill:
            patches.append(dict(name=keep["name"], area=keep["area"], **fill))

    out = os.path.join(os.path.expanduser("~/Desktop"),
                       f"PP_duplicates_{time.strftime('%Y-%m-%d')}.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(plan[0].keys()))
        w.writeheader()
        w.writerows(plan)

    print(f"\n{len(groups)} firm(s) are listed more than once in the same trade and postcode area.")
    print(f"{len(deletes)} row(s) would be removed; {len(patches)} surviving row(s) gain details from them.")
    print(f"Every one is listed in {out} — open it and check before applying.")
    if not APPLY:
        print("\nNothing has been changed. Re-run with --apply to make it so:\n    python3 dedupe_store.py --apply")
        return

    print("\nBacking up the whole store first…")
    b = subprocess.run([sys.executable, os.path.join(HERE, "backup.py")])
    if b.returncode != 0:
        sys.exit("backup failed — nothing deleted. Fix the backup, then re-run.")

    for i in range(0, len(patches), 200):
        d = post({"action": "merge", "rows": patches[i:i + 200]})
        print(f"  merged details into {d.get('merged', 0)} surviving row(s)")
    gone = 0
    for i in range(0, len(deletes), 40):   # kb deletes row by row inside a 26s function — 40 is a safe slice
        d = post({"action": "delete", "rows": deletes[i:i + 40]})
        gone += d.get("deleted", 0)
        print(f"  deleted {gone}/{len(deletes)}")
    after = post({"action": "stats"}).get("total")
    print(f"\nDone. {gone} duplicate row(s) removed. The store now holds {after} rows.")


if __name__ == "__main__":
    main()
