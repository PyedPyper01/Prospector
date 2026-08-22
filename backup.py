#!/usr/bin/env python3
"""
Back up the whole supplier store to a dated CSV on the Desktop.

Why this exists: Supabase's own "Download backups" button is only offered while a project is paused, and the
free plan keeps no automatic backups at all. Months of sourcing had no copy outside that one project.

Pages through the store 1000 rows at a time — a single "give me everything" call exceeds Netlify's 6MB
response cap and fails. Writes UTF-8 with a BOM so Excel opens it without mangling accents.

    python3 backup.py
"""
import csv, json, os, sys, time, urllib.request

KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
PAGE = 1000
COLS = ["id", "name", "trade", "category", "area", "district", "postcode", "address", "website", "phone",
        "email", "company_number", "source", "independence", "status", "description", "source_list",
        "last_verified", "notes"]


def post(payload, tries=3):
    for attempt in range(tries):
        try:
            r = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                                       headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(r, timeout=120) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1} after {e}")
            time.sleep(3)


def main():
    # Ask the store how many rows there SHOULD be, and keep going until we have them.
    # Treating a short page as "end of data" is wrong: one slow or partial response ends the read early and
    # produces a backup that looks complete and silently is not. That is the worst possible failure here.
    expected = post({"action": "stats"}).get("total")
    if not expected:
        sys.exit("could not read the row count from the store — refusing to write a backup I cannot verify")
    print(f"store reports {expected} rows")

    rows, offset, empty_pages = [], 0, 0
    while len(rows) < expected:
        d = post({"action": "get", "limit": PAGE, "offset": offset})
        if not d.get("ok"):
            sys.exit("store returned: " + json.dumps(d)[:300])
        got = d.get("results") or []
        if not got:
            empty_pages += 1
            if empty_pages >= 3:
                break                      # genuinely nothing left
            offset += PAGE
            continue
        empty_pages = 0
        rows.extend(got)
        print(f"  {len(rows)}/{expected} rows")
        offset += len(got)

    if len(rows) < expected:
        sys.exit(f"INCOMPLETE: read {len(rows)} of {expected} rows — not writing a partial backup. Re-run.")

    out = os.path.join(os.path.expanduser("~/Desktop"),
                       f"AfterLife_supplier_store_backup_{time.strftime('%Y-%m-%d')}.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c) for c in COLS})
    print(f"\n{len(rows)} rows → {out}")


if __name__ == "__main__":
    main()
