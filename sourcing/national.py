#!/usr/bin/env python3
"""
National sourcing run: one trade across every postcode area.

Geography comes from OUTCODE CENTROIDS, not town names. Postcode areas have no clean town list (CO7 alone
spans 22 parishes), but every outcode has a free centroid from postcodes.io, so pinning the Maps search to
each centroid covers an area uniformly and predictably — one credit per outcode.

Quality gates, all applied BEFORE anything is stored:
  · Google's own category label must match the trade   (drops supermarkets, garden centres, takeaways)
  · postcode area must match the one requested          (drops the CM florist found near Colchester)
  · a website is mandatory
"""
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, S)
from post import post

SERPER = "https://postcodeprospector.netlify.app/.netlify/functions/serper"
PC = re.compile(r"\b([A-Z]{1,2})\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b", re.I)
MAX_OUTCODES  = int(os.environ.get("MAX_OUTCODES", "10"))    # credit budget per area
SKIP_OUTCODES = int(os.environ.get("SKIP_OUTCODES", "0"))    # resume a capped area where the last run stopped
CREDITS = {"n": 0}

TRADES = {
  "Florists": (["florist"], r"florist|flower", r"supermarket|takeaway|garden cent|department store|discount store|post office|tyre|antique|carpet|lighting|cafe|pet groom|reflex|wedding service|celebrant"),
}

def jget(url, tries=2):
    for _ in range(tries):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "PostcodeProspector/1.0"})
            with urllib.request.urlopen(r, timeout=45) as resp: return json.loads(resp.read())
        except Exception: time.sleep(1)
    return None

def outcodes(area):
    """Outcode centroid AND its district name. Both are needed: `ll` on its own is NOT reliably honoured —
    the same Liverpool coordinates returned Brooklyn NY and Cambridge OH on different calls, and Colchester's
    returned Rutherford NJ. Sending `location` alongside pins the search to the right country every time."""
    def one(n):
        d = jget(f"https://api.postcodes.io/outcodes/{area}{n}", tries=1)
        r = (d or {}).get("result")
        if not r or r.get("latitude") is None: return None
        districts = r.get("admin_district") or []
        country = (r.get("country") or ["England"])[0]
        town = districts[0] if districts else area
        return (r["outcode"], r["latitude"], r["longitude"], f"{town}, {country}, United Kingdom")
    with ThreadPoolExecutor(max_workers=12) as ex:
        return [x for x in ex.map(one, range(1, 41)) if x]

def query(q, ll, location):
    CREDITS["n"] += 1
    try:
        req = urllib.request.Request(SERPER, data=json.dumps({"q": q, "ll": ll, "location": location}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read())
            # An exhausted balance or a bad key comes back as ok:false, NOT as an exception. Returning [] on
            # that would look exactly like "this area has no florists" and quietly hollow out the run — the
            # same silent-failure shape as the throttled Overpass empty array. Stop instead.
            if not d.get("ok"):
                raise SystemExit(f"\n*** SERPER REFUSED THE CALL: {json.dumps(d)[:200]}\n"
                                 f"*** Stopping. Credits used this run: {CREDITS['n']}. Top up and resume.")
            return d.get("results") or []
    except SystemExit: raise
    except Exception as e:
        print(f"      ! {e}"); return []

def run(trade, areas):
    syns, keep_re, drop_re = TRADES[trade]
    keep, drop = re.compile(keep_re, re.I), re.compile(drop_re, re.I)
    grand = 0
    for area in areas:
        ocs = outcodes(area)
        if not ocs:
            print(f"{area}: no outcodes resolved — SKIPPED"); continue
        used = ocs[SKIP_OUTCODES:SKIP_OUTCODES + MAX_OUTCODES]
        capped = max(0, len(ocs) - SKIP_OUTCODES - MAX_OUTCODES)
        if not used:
            print(f"{area}: nothing left beyond outcode {SKIP_OUTCODES} — already complete"); continue
        seen, found = set(), []
        for oc, lat, lon, loc in used:
            for syn in syns:
                for p in query(syn, f"@{lat:.4f},{lon:.4f},13z", loc):
                    site = (p.get("website") or "").strip()
                    if not site: continue
                    dom = re.sub(r"^https?://(www\.)?", "", site).split("/")[0].lower()
                    if dom in seen: continue
                    cat = p.get("category") or ""
                    if not keep.search(cat) or drop.search(cat): continue
                    m = PC.search(p.get("address") or "")
                    if not m or m.group(1).upper() != area: continue
                    seen.add(dom); found.append((p, dom))
            time.sleep(0.2)
        rows = [{"name": p["name"], "area": area, "website": p.get("website"), "phone": p.get("phone") or "",
                 "postcode": (PC.search(p.get("address") or "") or [None]) and PC.search(p["address"]).group(0).upper(),
                 "address": (p.get("address") or "").replace(", United Kingdom", ""),
                 "notes": f"Google category: {p.get('category','')}"} for p, _ in found]
        n = post(rows, trade, tag="claude-serper")
        note = f" (capped: {capped} further outcodes not queried)" if capped else ""
        print(f"{area}: outcodes {SKIP_OUTCODES+1}-{SKIP_OUTCODES+len(used)} of {len(ocs)} -> {len(found)} on-trade with website -> {n} new{note}  [credits {CREDITS['n']}]")
        grand += n
    print(f"\nTOTAL new rows: {grand} | credits used this run: {CREDITS['n']}")

if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2:])
