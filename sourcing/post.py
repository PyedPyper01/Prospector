#!/usr/bin/env python3
"""
Post sourced firms to the supplier store.

Two guards, both from real failures:
  · WEBSITE — a row without one is not a lead, so it is refused rather than stored and chased later.
  · DUPLICATE — the store's unique key is name+area, so "Dillys" and "Dillys Bespoke Florist" are two rows
    by definition. Before inserting, pull what is already stored for this trade+area and match on a squashed
    name AND on the domain, so a variant spelling of a firm already held is skipped instead of duplicated.
"""
import json, re, urllib.request
KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"

def _call(payload):
    req = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())

def _key(n):
    # Strip ONLY legal suffixes and punctuation. An earlier version also stripped trade words
    # (florist/flowers/design...) which collapsed "Florist Bromley" and "Bromley Florist" — two different
    # businesses on two different domains — into one key and silently dropped the second.
    # The Dillys case that motivated deduping is caught by the DOMAIN test instead, which is the reliable one.
    n = (n or "").lower()
    n = re.sub(r"\b(ltd|limited|llp|plc)\b", " ", n)
    return re.sub(r"[^a-z0-9]", "", n)

def _dom(u):
    m = re.search(r"https?://(?:www\.)?([^/?#]+)", (u or "").lower())
    return m.group(1) if m else ""

def post(rows, trade, tag="claude-sourced", area=None):
    areas = {r["area"].upper() for r in rows}
    held_names, held_doms = set(), set()
    for a in areas:
        try:
            for e in (_call({"action": "get", "trade": trade, "area": a, "limit": 2000}).get("results") or []):
                held_names.add((_key(e.get("name")), a)); 
                if e.get("website"): held_doms.add((_dom(e["website"]), a))
        except Exception as ex:
            print(f"  ! could not read existing {a}: {ex}")

    out, seen, no_site, dupes = [], set(), [], []
    for r in rows:
        a = r["area"].upper()
        site = (r.get("website") or "").strip()
        if not site:
            no_site.append(r.get("name")); continue
        k, d = (_key(r["name"]), a), (_dom(site), a)
        if k in held_names or d in held_doms or k in seen:
            dupes.append(r["name"]); continue
        seen.add(k)
        out.append({"name": r["name"], "trade": trade, "area": a,
                    "postcode": r.get("postcode") or "", "address": r.get("address") or "",
                    "website": site, "phone": r.get("phone") or "", "email": "",
                    "source": tag, "status": "new", "notes": r.get("notes") or ""})
    if no_site: print("  refused, no website:", ", ".join(no_site))
    if dupes:   print("  already held:", ", ".join(dupes))
    for i in range(0, len(out), 100):
        print("  ->", json.dumps(_call({"action": "upsert", "rows": out[i:i+100]}))[:100])
    return len(out)
