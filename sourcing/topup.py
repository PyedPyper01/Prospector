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
HARD_CAP = {"credits": 0}      # set from CREDIT_BUDGET; a real stop during the run, not just at build time

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
    if HARD_CAP["credits"] and spent["q"] * CREDITS_PER_QUERY >= HARD_CAP["credits"]:
        raise SystemExit(f"\n*** Credit cap of {HARD_CAP['credits']} reached — stopping. Everything found is already saved.")
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
    # A row is worth topping up if it is missing ANY of phone / postcode / address. Maps returns all three
    # in the same result, so filling one costs exactly the same as filling three.
    def thin(r):
        return (r.get("website") or "").strip() and not all(
            (r.get(f) or "").strip() for f in ("phone", "postcode", "address"))
    gaps = [r for r in rows if thin(r)]

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
    print(f"rows missing phone/postcode/address on Maps-able trades: "
          f"{sum(len(v) for v in targeted.values()) + sum(len(v) for v in orphans.values())}")
    print(f"  TARGETED  {tq:>5} district+trade pairs = {tq*CREDITS_PER_QUERY:>6} credits  (covers {sum(len(v) for v in targeted.values())} rows)")
    print(f"  BROADER   {len(orphans):>5} area+trade pairs, no postcode recorded")
    print(f"            at ~14 districts each      = {len(orphans)*14*CREDITS_PER_QUERY:>6} credits  (covers {sum(len(v) for v in orphans.values())} rows)")
    if not do_run:
        print("\nnothing changed — add --run to do the targeted pass, --run --broad for both")
        return

    # With --broad, skip the targeted district jobs: they are cheap, quick, and normally already done, so
    # leaving them at the front of a 22,000-job queue just spends credits re-checking solved rows.
    jobs = [] if do_broad else [(oc, t, rs) for (oc, t), rs in targeted.items()]

    if do_broad:
        # A query costs the same whether it matches twenty firms or none, so the return depends entirely on how
        # many gap-firms sit in the district being searched. Work the biggest area+trade pairs FIRST and stop at
        # the budget: that way the money buys the most records it can, rather than being spread evenly over
        # pairs holding one firm each.
        budget = int(os.environ.get("CREDIT_BUDGET", "70000"))
        HARD_CAP["credits"] = budget
        per_area = int(os.environ.get("DISTRICTS_PER_AREA", "14"))
        ranked = sorted(orphans.items(), key=lambda x: -len(x[1]))
        # Cap the job list by ARITHMETIC, not by checking spend while building it — at build time nothing has
        # been spent, so the guard never fired and a $9 budget ran to $18 before it was noticed.
        max_jobs = max(1, budget // CREDITS_PER_QUERY)
        for (area, trade), rs in ranked:
            if len(jobs) >= max_jobs: break
            for n in range(1, per_area + 1):
                if len(jobs) >= max_jobs: break
                jobs.append((f"{area}{n}", trade, rs))
        print(f"\nbroad pass: {len(ranked)} pairs available, biggest first · capped at {len(jobs)} jobs "
              f"= {len(jobs)*CREDITS_PER_QUERY} credits (${len(jobs)*CREDITS_PER_QUERY/1000:.2f})")

    print(f"\nrunning over {len(jobs)} district+trade pairs…")

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
                if not d or d not in want: continue
                row = want[d]
                patch = {"name": row["name"], "area": row["area"]}
                if not (row.get("phone") or "").strip() and (p.get("phone") or "").strip():
                    patch["phone"] = p["phone"].strip()
                addr = (p.get("address") or "").replace(", United Kingdom", "").strip()
                if not (row.get("address") or "").strip() and addr:
                    patch["address"] = addr
                m2 = re.search(r"\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b", addr, re.I)
                if not (row.get("postcode") or "").strip() and m2:
                    patch["postcode"] = m2.group(0).upper()
                if len(patch) > 2: out.append(patch)
                want.pop(d, None)
            if not want: break
        return out

    seen_keys = set()
    def flush(batch):
        """Write NOW. Holding matches until the end means stopping the run — for any reason — throws away
        everything it found. That is exactly what happened once: 8,311 matched firms lost on a kill."""
        uniq = []
        for f in batch:
            k = (f["name"], f["area"])
            if k in seen_keys: continue
            seen_keys.add(k); uniq.append(f)
        for i in range(0, len(uniq), 100):
            post(KB, {"action": "patch", "rows": uniq[i:i+100]})
        return len(uniq)

    written = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        for res in ex.map(work, jobs):
            checked += 1
            fixed += res
            if len(fixed) >= 300:
                written += flush(fixed); fixed = []
            if checked % 100 == 0:
                cr = spent['q'] * CREDITS_PER_QUERY
                tot = written + len(fixed)
                print(f"   {checked}/{len(jobs)} · {tot} improved ({written} saved) · {cr} credits "
                      f"(${cr/1000:.2f}) · {cr/max(1,tot):.1f} each")
    # de-dupe patches
    written += flush(fixed)
    cr = spent['q'] * CREDITS_PER_QUERY
    print(f"\nimproved {written} firms · {spent['q']} queries = {cr} credits (${cr/1000:.2f})")

if __name__ == "__main__":
    main()
