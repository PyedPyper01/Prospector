#!/usr/bin/env python3
"""
Fill missing phone numbers on rows we ALREADY hold, without re-sourcing the trade.

The saving is in not searching where there is nothing to find. A blind national re-run is ~65,000 queries;
querying only the postcode districts that actually contain a phone-less firm is a few hundred.

Matching is by WEBSITE DOMAIN, never by name — so a number can only ever attach to the firm whose own site
it came from. Rows are PATCHED, so nothing else on them is touched.

    python3 topup.py                 # price it, change nothing
    python3 topup.py --run           # do the cheap targeted pass
    python3 topup.py --run --broad   # also cover rows with no postcode (much dearer — it prices it first)
"""
import json, os, re, sys, time, urllib.request, collections
from concurrent.futures import ThreadPoolExecutor

KB     = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
SERPER = "https://postcodeprospector.netlify.app/.netlify/functions/serper"
OC     = re.compile(r"^([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}$", re.I)
CREDITS_PER_QUERY = 3
spent = {"q": 0}

def post(url, payload, timeout=180):
    r = urllib.request.Request(url, data=json.dumps(payload).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=timeout) as x:
        return json.loads(x.read())

def dom(u):
    m = re.search(r"https?://(?:www\.)?([^/?#]+)", (u or "").lower())
    return m.group(1) if m else ""

def all_rows():
    out, off = [], 0
    while True:
        d = post(KB, {"action": "get", "limit": 1000, "offset": off})
        got = d.get("results") or []
        out += got
        if len(got) < 1000: break
        off += 1000
        if off > 80000: break
    return out

def outcode_centre(code):
    try:
        r = urllib.request.Request(f"https://api.postcodes.io/outcodes/{code}",
                                   headers={"User-Agent": "PostcodeProspector/1.0"})
        with urllib.request.urlopen(r, timeout=30) as x:
            res = json.loads(x.read()).get("result")
        if not res or res.get("latitude") is None: return None
        town = (res.get("admin_district") or [code])[0]
        country = (res.get("country") or ["England"])[0]
        return (res["latitude"], res["longitude"], f"{town}, {country}, United Kingdom")
    except Exception:
        return None

def maps(term, centre):
    spent["q"] += 1
    lat, lon, loc = centre
    try:
        d = post(SERPER, {"q": term, "ll": f"@{lat:.4f},{lon:.4f},13z", "location": loc}, timeout=90)
        if not d.get("ok"):
            raise SystemExit(f"\n*** Serper refused: {json.dumps(d)[:160]}\n*** Stopping after {spent['q']} queries.")
        return d.get("results") or []
    except SystemExit: raise
    except Exception as e:
        print(f"      ! {e}"); return []

def load_terms():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "trades.json"), encoding="utf-8") as f:
        return {k: v["terms"] for k, v in json.load(f).items()}

def main():
    do_run  = "--run" in sys.argv
    do_broad = "--broad" in sys.argv
    TERMS = load_terms()
    rows = all_rows()
    gaps = [r for r in rows if (r.get("website") or "").strip() and not (r.get("phone") or "").strip()]

    targeted = collections.defaultdict(list)     # (outcode, trade) -> rows
    orphans  = collections.defaultdict(list)     # (area, trade)    -> rows  (no postcode to aim at)
    for r in gaps:
        t = r.get("trade") or ""
        if t not in TERMS:            # not a Maps trade — Maps cannot help it
            continue
        m = OC.match((r.get("postcode") or "").strip())
        if m: targeted[(m.group(1).upper(), t)].append(r)
        else: orphans[((r.get("area") or "").upper(), t)].append(r)

    tq = len(targeted)
    print(f"phone gaps on Maps-able trades: {sum(len(v) for v in targeted.values()) + sum(len(v) for v in orphans.values())}")
    print(f"  TARGETED  {tq:>5} district+trade pairs = {tq*CREDITS_PER_QUERY:>6} credits  (covers {sum(len(v) for v in targeted.values())} rows)")
    print(f"  BROADER   {len(orphans):>5} area+trade pairs, no postcode recorded")
    print(f"            at ~14 districts each      = {len(orphans)*14*CREDITS_PER_QUERY:>6} credits  (covers {sum(len(v) for v in orphans.values())} rows)")
    if not do_run:
        print("\nnothing changed — add --run to do the targeted pass, --run --broad for both")
        return

    jobs = [(oc, t, rs) for (oc, t), rs in targeted.items()]
    if do_broad:
        print("\n--broad given: the broader pass is not run automatically. Do the targeted pass first, re-measure,")
        print("then decide — the free website crawl usually closes much of the gap for nothing.")
    print(f"\nrunning the targeted pass over {len(jobs)} district+trade pairs…")

    fixed, checked = [], 0
    def work(job):
        oc, trade, rs = job
        centre = outcode_centre(oc)
        if not centre: return []
        want = {dom(r["website"]): r for r in rs if dom(r["website"])}
        out = []
        for term in TERMS[trade][:1]:                 # one term is enough to find a firm we already know of
            for p in maps(term, centre):
                d = dom(p.get("website"))
                ph = (p.get("phone") or "").strip()
                if d and ph and d in want:
                    out.append({"name": want[d]["name"], "area": want[d]["area"], "phone": ph})
                    want.pop(d, None)
            if not want: break
        return out

    with ThreadPoolExecutor(max_workers=4) as ex:
        for res in ex.map(work, jobs):
            checked += 1
            fixed += res
            if checked % 50 == 0:
                print(f"   {checked}/{len(jobs)} pairs · {len(fixed)} phones matched · {spent['q']*CREDITS_PER_QUERY} credits")
    # de-dupe patches
    seen, clean = set(), []
    for f in fixed:
        k = (f["name"], f["area"])
        if k in seen: continue
        seen.add(k); clean.append(f)
    print(f"\nmatched {len(clean)} phone numbers · {spent['q']} queries = {spent['q']*CREDITS_PER_QUERY} credits")
    for i in range(0, len(clean), 100):
        print("   ", json.dumps(post(KB, {"action": "patch", "rows": clean[i:i+100]}))[:90])

if __name__ == "__main__":
    main()
