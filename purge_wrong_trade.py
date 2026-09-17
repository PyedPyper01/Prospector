#!/usr/bin/env python3
"""
Remove stored rows that are the wrong trade — today, solicitors' practices filed under will writers.

The will-writer sweep used to KEEP Google's "Law firm", "Solicitor" and "Lawyer" categories, so 1,506 of
the 2,441 rows stored as "Will writers & LPA drafters" are solicitors' practices. They are not will
writers; they belong under Probate solicitors, sourced as that trade. Leaving them means every load of
this trade is two-thirds noise and every Vet & Rank pays to reject them again.

A row is a solicitors' practice when its NAME says so — Solicitors, LLP, Law, Chambers, Barrister,
Conveyancing, Notary — the same test the sweep now applies on the way in. Nothing else is judged here.

    python3 purge_wrong_trade.py            # report only — writes a CSV of every row it would remove
    python3 purge_wrong_trade.py --apply    # back up the whole store first, then delete

Nothing is deleted without --apply, and --apply refuses to run until a full backup has been written.
"""
import csv, json, os, re, subprocess, sys, time, urllib.request

KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
HERE = os.path.dirname(os.path.abspath(__file__))
APPLY = "--apply" in sys.argv

TRADE = "Will writers & LPA drafters"
# identical to nameDrop for this trade in trades.json — keep the two in step
WRONG = re.compile(r"solicitor|\bllp\b|\blaw\b|barrister|chambers|conveyanc|notar", re.I)


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


def main():
    d = post({"action": "get", "trade": TRADE, "limit": 20000})
    rows = d.get("results") or []
    if not rows:
        sys.exit(f"the store returned no rows for {TRADE!r} — stopping: " + json.dumps(d)[:200])
    wrong = [r for r in rows if WRONG.search(r.get("name") or "")]
    print(f"{len(rows)} rows stored as {TRADE!r}; {len(wrong)} are solicitors' practices by name "
          f"({len(wrong) * 100 // len(rows)}%), {len(rows) - len(wrong)} would remain.\n")

    out = os.path.join(os.path.expanduser("~/Desktop"), f"PP_wrong_trade_{time.strftime('%Y-%m-%d')}.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["name", "area", "website", "phone", "email", "why"])
        for r in wrong:
            w.writerow([r.get("name"), r.get("area"), r.get("website") or "", r.get("phone") or "",
                        r.get("email") or "", "name matches: " + WRONG.search(r.get("name") or "").group(0)])
    print(f"Every one is listed in {out} — open it and check before applying.")
    print("Sample:")
    for r in wrong[:12]:
        print(f"   [{r.get('area')}] {r.get('name')}")
    if not APPLY:
        print("\nNothing has been changed. Re-run with --apply to remove them:\n    python3 purge_wrong_trade.py --apply")
        return

    print("\nBacking up the whole store first…")
    b = subprocess.run([sys.executable, os.path.join(HERE, "backup.py")])
    if b.returncode != 0:
        sys.exit("backup failed — nothing deleted. Fix the backup, then re-run.")

    gone = 0
    dels = [{"name": r["name"], "area": r["area"]} for r in wrong]
    for i in range(0, len(dels), 40):    # kb deletes row by row inside a 26s function — 40 is a safe slice
        d = post({"action": "delete", "rows": dels[i:i + 40]})
        gone += d.get("deleted", 0)
        print(f"  deleted {gone}/{len(dels)}")
    left = post({"action": "get", "trade": TRADE, "limit": 20000}).get("count")
    print(f"\nDone. {gone} solicitors' practice(s) removed from {TRADE!r}; {left} rows remain.")


if __name__ == "__main__":
    main()
