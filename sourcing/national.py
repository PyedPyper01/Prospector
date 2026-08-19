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

# trade -> (search terms, KEEP these Google categories, DROP these).
# Every KEEP/DROP list below was written from a live sample of what Google actually returns for that search,
# not from guesswork. Filtering on Google's own category label is far more reliable than reading the business
# name — it is what removes supermarkets from florists and taxi firms from funeral transport.
TRADES = {
 "Florists": (["florist"], r"florist|flower",
   r"supermarket|takeaway|garden cent|department store|discount store|post office|tyre|antique|carpet|lighting|cafe|pet groom|reflex|wedding service|celebrant"),
 "Funeral directors (full service)": (["funeral director"], r"funeral director|funeral home|cremation service",
   r"corporate office|florist|mason|monument|cemetery"),
 "Celebrants": (["funeral celebrant", "celebrant"], r"celebrant",
   r"funeral director|funeral home|wedding venue|photograph"),
 "Funeral catering & wakes": (["caterer", "catering company"], r"caterer|catering|hog roast|buffet",
   r"supermarket|takeaway|restaurant$|grocery"),
 "Wake venues": (["function room hire"], r"events? venue|function room|community cent|pub|hotel|social club",
   r"wedding venue|nightclub"),
 "Funeral photographers": (["photographer"], r"photographer|photography studio|photography service|portrait studio",
   r"aerial|drone|commercial photographer|photo lab|school photo"),
 "Funeral videographers & livestream": (["videographer"], r"video production|videograph",
   r"wedding photographer|aerial|dj service|photography service"),
 "Order-of-service printers": (["printing company", "funeral stationery printer"], r"print shop|commercial printer|copy shop|digital printing|printing",
   r"shipping and mailing|graphic design|photo lab|sign"),
 "Funeral transport": (["limousine hire"], r"limousine|chauffeur",
   r"taxi service|bus|coach hire|car rental"),
 "Memorial masons & stonemasons": (["memorial mason", "stonemason"], r"mason|monument|stone|memorial|headstone|engrav",
   r"funeral director|funeral home|worktop|kitchen|bathroom|tiling|paving|driveway|fireplace"),
 "Memorial benches, trees & plaques": (["memorial bench"], r"monument maker|memorial$|engrav|sign",
   r"historical landmark|park$|sculpture|memorial park|tourist attraction|cemetery"),
 "Private cemeteries": (["cemetery"], r"^cemetery$",
   r"military|pet cemetery|place of worship|historical landmark|park"),
 "Natural & woodland burial grounds": (["natural burial ground", "woodland burial"], r"cemetery|burial",
   r"military|place of worship|historical landmark"),
 "Private crematoria": (["crematorium"], r"cremation|crematorium",
   r"bus stop|pet funeral|pet cremation|funeral director|funeral home|cemetery"),
 "Probate solicitors": (["probate solicitor", "wills and probate solicitor"], r"law firm|legal services|lawyer|attorney|solicitor|conveyancer",
   r"personal injury|immigration|criminal|marketing|recruit"),
 "Conveyancing solicitors": (["conveyancing solicitor"], r"law firm|legal services|lawyer|attorney|conveyancer|solicitor",
   r"personal injury|immigration|criminal|marketing|recruit"),
 "Probate accountants": (["accountant"], r"accountant|accounting firm|chartered accountant",
   r"tax preparation service|bookkeep|payroll|marketing"),
 "Will writers & LPA drafters": (["will writing service"], r"legal services|estate planning|lawyer|law firm|solicitor|will",
   r"non-profit|charity|personal injury|recruit"),
 "RICS chartered surveyors": (["chartered surveyor"], r"surveyor",
   r"real estate agent|estate agent|structural engineer|architect"),
 "Estate clearance specialists": (["house clearance", "probate house clearance"], r"house clearance|clearance service",
   r"waste-?management|second-?hand furniture|charity shop|skip hire"),
 "House clearance, removals & storage": (["removals company"], r"mover|moving and storage|removal|self-?storage",
   r"transportation service|courier|haulage|van rental"),
 "Auction houses": (["auction house"], r"auction",
   r"auto auction|car auction|house clearance|real estate auctioneer"),
 "Garden maintenance (void property)": (["garden maintenance"], r"gardener|landscap|lawn care|arborist|tree surgeon",
   r"pressure washing|garden cent|nursery|florist"),
 "Locksmiths (securing property)": (["locksmith"], r"locksmith|lock",
   r"auto ?locksmith|car key|cell phone|do-it-yourself|hardware|shoe repair"),
 "Bereavement & pension IFAs": (["independent financial adviser"], r"financial planner|financial consultant|financial advisor|financial adviser|investment service|wealth",
   r"marketing agency|financial institution|bank|^consultant$|insurance agency|mortgage lender"),
 "Life insurance brokers": (["insurance broker"], r"insurance broker|insurance agency",
   r"mortgage broker|insurance company|car insurance|bank"),
 "Equity release advisers": (["equity release adviser"], r"mortgage broker|financial consultant|financial planner|financial advisor",
   r"mortgage lender|financial institution|business to business|bank|estate agent"),
 "Home care agencies": (["home care agency"], r"home health care|home care|nursing agency|care agency",
   r"nursing home|retirement home|hospital|pharmacy"),
 "Domiciliary & live-in care": (["domiciliary care", "live-in care"], r"home health care|home care|nursing agency|care agency",
   r"nursing home|retirement home|hospital|pharmacy"),
 "Private bereavement counsellors": (["bereavement counsellor", "grief counselling"], r"counselor|counsellor|psychotherapist|mental health",
   r"non-?profit|charity|hospital|nhs|life coach|hypno"),
 "Kennels & catteries": (["boarding kennels", "cattery"], r"pet boarding|kennel|cattery|dog day care",
   r"pet sitter|veterinar|pet shop|groom"),
 "Pet rehoming agencies": (["animal rescue centre"], r"animal rescue|animal shelter|pet adoption",
   r"thrift store|charity shop|veterinar|pharmacy|pet shop"),
}

# NOT Maps trades — these are national, tiny, or register-based, and a per-area Maps sweep produces noise.
# Source them from the trade body or register named in the table in sourcing.md instead:
#   Direct cremation specialists · Repatriation specialists · Embalming specialists · Custom coffin makers
#   Memorial jewellery & cremation art · Ash scattering services · Wills storage services
#   Probate genealogists · IHT planning & trust services · Care home placement consultants
#   Children's bereavement specialists · Property security & insurance · Funeral musicians

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
    def fetch(code):
        d = jget(f"https://api.postcodes.io/outcodes/{code}", tries=1)
        r = (d or {}).get("result")
        if not r or r.get("latitude") is None: return None
        districts = r.get("admin_district") or []
        country = (r.get("country") or ["England"])[0]
        town = districts[0] if districts else area
        return (r["outcode"], r["latitude"], r["longitude"], f"{town}, {country}, United Kingdom")

    # Central London outcodes carry a LETTER suffix — EC1A, WC1A, W1B — and no plain EC1 or WC1 exists.
    # Probing numbers alone found nothing for EC and WC, so both areas were silently skipped entirely.
    def one(n):
        hit = fetch(f"{area}{n}")
        if hit: return [hit]
        return [h for h in (fetch(f"{area}{n}{L}") for L in "ABCDEHMNPRVXY") if h]

    with ThreadPoolExecutor(max_workers=12) as ex:
        return [x for grp in ex.map(one, range(1, 41)) for x in grp]

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
