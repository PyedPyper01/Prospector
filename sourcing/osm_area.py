#!/usr/bin/env python3
"""Enumerate a trade across an ENTIRE postcode area from OpenStreetMap, not one 5km box."""
import json, sys, time, urllib.parse, urllib.request

MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]

def get(url, tries=2):
    for _ in range(tries):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "PostcodeProspector/1.0"})
            with urllib.request.urlopen(r, timeout=60) as resp: return json.loads(resp.read())
        except Exception: time.sleep(2)
    return None

def outcodes(area):
    """Every outcode in a postcode area. postcodes.io has no prefix search, so probe AREA1..AREA40
    concurrently — each lookup is a cheap free call and the misses simply 404."""
    from concurrent.futures import ThreadPoolExecutor
    def one(n):
        d = get(f"https://api.postcodes.io/outcodes/{area}{n}", tries=1)
        r = (d or {}).get("result")
        return (r["outcode"], r["latitude"], r["longitude"]) if r and r.get("latitude") is not None else None
    with ThreadPoolExecutor(max_workers=12) as ex:
        found = [x for x in ex.map(one, range(1, 41)) if x]
    return found

def bbox(pts, pad=0.06):
    la=[p[1] for p in pts]; lo=[p[2] for p in pts]
    return f"{min(la)-pad:.4f},{min(lo)-pad:.4f},{max(la)+pad:.4f},{max(lo)+pad:.4f}"

def overpass(q):
    for m in MIRRORS:
        try:
            r = urllib.request.Request(m, data=("data="+urllib.parse.quote(q)).encode(),
                headers={"Content-Type":"application/x-www-form-urlencoded","User-Agent":"PostcodeProspector/1.0"})
            with urllib.request.urlopen(r, timeout=90) as resp:
                d = json.loads(resp.read())
                if d.get("elements"): return d
        except Exception: pass
        time.sleep(1)
    return None

def sweep(area, tags):
    ocs = outcodes(area)
    if not ocs: return area, [], 0
    filt = "\n".join(f'nwr[{t}]({bbox(ocs)});' for t in tags)
    d = overpass(f"[out:json][timeout:90];({filt});out center tags 400;")
    els = (d or {}).get("elements") or []
    firms = []
    for e in els:
        t = e.get("tags") or {}
        if not t.get("name"): continue
        firms.append({"name": t["name"],
                      "website": t.get("website") or t.get("contact:website") or "",
                      "phone": t.get("phone") or t.get("contact:phone") or "",
                      "postcode": t.get("addr:postcode") or "",
                      "address": " ".join(x for x in [t.get("addr:housenumber"),t.get("addr:street"),t.get("addr:city")] if x)})
    seen=set(); uniq=[]
    for f in firms:
        k=f["name"].lower().strip()
        if k in seen: continue
        seen.add(k); uniq.append(f)
    return area, uniq, len(ocs)

if __name__ == "__main__":
    for area in sys.argv[1:]:
        a, firms, n = sweep(area, ['"shop"="florist"'])
        withsite = sum(1 for f in firms if f["website"])
        print(f"{a}: {len(firms)} florists across {n} outcodes | {withsite} already have a website tag")
        for f in firms[:5]: print("    ", f["name"][:34].ljust(34), f["website"][:38])
