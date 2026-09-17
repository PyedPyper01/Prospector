#!/usr/bin/env python3
"""
Source will writers from the Institute of Professional Willwriters' own membership directory.

Google Maps is the wrong place to look for this trade: it files solicitors and will writers under the same
categories, and a district search returns the twenty most relevant — in a city that is mostly solicitors.
The IPW directory is the opposite: every entry is a will writer by definition, membership is the credential
Vet & Rank looks for, and the directory's search backend answers with the whole membership in one JSON
response (postcode + 200 miles = 246 firms from CO1). Each firm's details — address, postcode, phone,
website, profile, rating — come from a second call per firm.

Writes straight into the shared supplier store as "Will writers & LPA drafters", source "ipw", so the
next load of that trade in Prospector has them. Safe to re-run: the store merges on name + area.

    python3 ipw.py            # report what it would write, save a CSV, write nothing
    python3 ipw.py --apply    # write to the store
"""
import csv, json, os, re, sys, time, urllib.parse, urllib.request

APPLY = "--apply" in sys.argv
KB = "https://postcodeprospector.netlify.app/.netlify/functions/kb"
IPW = "https://www.ipw.org.uk/_Processing/_JSON.aspx"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TRADE = "Will writers & LPA drafters"
EW = set(("AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DE DH DL DN DT DY E EC EN EX FY GL GU "
          "HA HD HG HP HR HU IG IP KT L LA LD LE LL LN LS LU M ME MK N NE NG NN NP NR NW OL OX PE PL PO PR RG "
          "RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS "
          "WV YO").split())
PC = re.compile(r"^([A-Z]{1,2})\d")


def get(params):
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(IPW + "?" + q, headers={"User-Agent": UA, "Referer": "https://www.ipw.org.uk/Membership-Directory/"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(3)


def kb(payload):
    req = urllib.request.Request(KB, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def site(u):
    u = (u or "").strip()
    if not u:
        return ""
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def main():
    # One query from a central postcode with the widest radius returns every member. Page anyway, in
    # case the membership ever outgrows a page.
    members, start, seen = [], 1, set()
    while True:
        d = get({"type": "company-search", "sortBy": "", "minRating": 0, "within": 200,
                 "postcode": "CO1", "specialisation": "", "city": "", "name": "", "start": start})
        recs = d.get("records") or []
        new = [r for r in recs if r.get("guid") not in seen]
        if not new:
            break
        for r in new:
            seen.add(r["guid"])
        members.extend(new)
        total = int(recs[0].get("totalresults") or 0) if recs else 0
        if len(members) >= total:
            break
        start += len(recs)
    print(f"IPW directory lists {len(members)} member firm(s). Fetching details…")

    rows, skipped = [], []
    for i, m in enumerate(members, 1):
        d = get({"type": "company-details", "guid": m["guid"], "addressNumber": m.get("addressnumber") or 1})
        r = (d.get("records") or [{}])[0]
        pc = (r.get("postalpostcode") or "").strip().upper()
        area = PC.match(pc.replace(" ", "")).group(1) if PC.match(pc.replace(" ", "")) else ""
        if area not in EW:
            skipped.append((r.get("companyname"), pc or "(no postcode)"))
            continue
        addr = ", ".join(x for x in (r.get("postaladdress1"), r.get("postaladdress2"), r.get("postaladdress3"),
                                     r.get("postaltowncity"), r.get("postalcounty")) if x)
        profile = re.sub(r"\s+", " ", r.get("directoryprofile") or "").strip()
        rows.append({
            "name": (r.get("companyname") or m.get("companyname") or "").strip()[:300],
            "trade": TRADE,
            "area": area,
            "district": pc.split(" ")[0] if " " in pc else pc[:-3],
            "postcode": pc,
            "address": addr[:300],
            "website": site(r.get("website")),
            "phone": (r.get("telephone") or "").strip(),
            "email": (r.get("organisationemailaddress") or "").strip().lower(),
            "source": "ipw",
            "source_list": "IPW membership directory",
            "independence": "IPW member",
            "notes": ("IPW member" + (f" · {r.get('rating')}/5 from {r.get('totalreviews')} review(s)" if r.get("totalreviews") else "")
                      + (f" · profile: {profile[:600]}" if profile else "")),
            "last_verified": time.strftime("%Y-%m-%d"),
        })
        if i % 25 == 0:
            print(f"  {i}/{len(members)}")
        time.sleep(0.4)     # a member directory, not an API — do not hammer it

    with_site = sum(1 for r in rows if r["website"])
    with_phone = sum(1 for r in rows if r["phone"])
    with_email = sum(1 for r in rows if r["email"])
    print(f"\n{len(rows)} will writers in England & Wales — {with_site} with a website, {with_phone} with a phone, "
          f"{with_email} with an email. {len(skipped)} skipped (outside England & Wales or no postcode).")
    by_area = {}
    for r in rows:
        by_area[r["area"]] = by_area.get(r["area"], 0) + 1
    print("areas covered:", len(by_area), "·", ", ".join(f"{a}:{n}" for a, n in sorted(by_area.items(), key=lambda x: -x[1])[:15]), "…")

    out = os.path.join(os.path.expanduser("~/Desktop"), f"IPW_will_writers_{time.strftime('%Y-%m-%d')}.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"Saved to {out}")

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
    print(f"\nDone. {written} IPW will writers are in the store as {TRADE!r}. Load that trade in Prospector to see them.")


if __name__ == "__main__":
    main()
