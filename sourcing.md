# Postcode Prospector — supplier sourcing

You source UK supplier leads for **AfterLife**, a bereavement marketplace, and load them into the shared
Postcode Prospector database.

When I give you a trade name ("source Celebrants"), follow everything below without being asked again.

---

## MY TAG

Put `jude-sourced` in the `source` field of every row you ever load. This never changes.

---

## THE TWO RULES THAT MATTER MOST

### 1. Directories enumerate. Searches only sample.

A web search returns about ten PAGES ranked by relevance. It is not a list of the businesses in a town, and it
never will be — no matter how you word it. A directory page lists every one and usually states its own total.

Sourcing a trade from search results alone will always come up thin. This is the single biggest cause of a weak
list, and it is easy to miss because a search result LOOKS like an answer.

**So for every area, enumerate first, then search:**

1. **The trade body / consumer directory** named in the table below. Fetch it and PAGE THROUGH TO THE END.
   If the page says 26 and you have 10, fetch page 2, 3, 4 until you have them all.
2. **The local paper's "best/top rated X in <town>" article.** These republish Google's own ratings, which is
   the business register you otherwise cannot reach. Free, fetchable, and they routinely name firms no search
   surfaces. Search `best <trade> <town> top rated` to find them.
3. **Then a plain web search** to catch what the directories missed.

Yell.com and Thomson Local both return **403 Forbidden** to automated fetches — do not waste calls on them.
Direct2Florist, the trade bodies, local town directories and the local press all work.

Expect **three to five sources per area**. One search is a sample, not a list.

### 2. No website, no row.

The website is the field the sales team cannot work without. A firm with no website is not a usable lead.

**Never conclude that a firm has no website until you have searched its name directly.** "No website appeared
in the directory listing" is a fact about the listing, not about the business. Elegance of Essex, Vanessa's
Florist and several others were written off this way and every one of them had a perfectly good site — found
in a single name search. Absence of evidence is not evidence of absence, and reporting it as fact is worse
than leaving the row out.

So: collect the names first, then resolve a website for **each** name. Only after a direct name search comes
back empty may a firm be recorded without one — and then say so plainly rather than dropping it silently.

## HOW TO WORK

Do **not** ask me to confirm anything. Do **not** pause between batches. Do **not** run batches in parallel or
spawn background agents. Work sequentially and continuously, then report once at the end.

**1. Check what's already stored.** POST `{"action":"get","trade":"<THE TRADE>","limit":20000}` to the endpoint.
Skip postcode areas that already appear. This means an interruption costs nothing — re-running resumes.

**2. Loop, 8 areas at a time:**
- Work the directory for each area (paging to the end), then fill gaps by search
- POST that batch
- Confirm `{"ok":true,...}`; if `ok:false`, fix and resend
- Start the next 8 immediately. **Never accumulate results to load at the end.**

**3. Stop when every area below is stored.** Report totals and flag any area that came back below its expected
yield — that's a signal the directory was missed, not that the firms don't exist.

---

## THE AREAS (England & Wales)

```
AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DE DH DL DN DT DY E EC EN EX FY GL GU HA
HD HG HP HR HU IG IP KT L LA LD LE LL LN LS LU M ME MK N NE NG NN NP NR NW OL OX PE PL PO PR RG RH RM S
SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS WV YO
```

Skip entirely: `AB DD DG EH FK G HS IV KA KW KY ML PA PH TD ZE BT IM GY JE`

**London and rural Wales** (`E EC N NW SE SW W WC HA IG KT RM TW UB` and `LD LL`): search by **district name**,
not postcode letters — "Wimbledon Clapham Putney", "Llandudno Bangor Wrexham". Postcode-letter searches return
generic filler in those areas.

---

## SOURCE TABLE — the defined parameters for every trade

**Method key:** **DIR** = fetch and page the directory · **REG** = official register · **SRCH** = per-area web search (last resort)

| Trade | Primary source | Method | Expect per area |
|---|---|---|---|
| Funeral directors (full service) | funeral-directory.co.uk (NAFD, postcode search) + saif.org.uk members search + funeralguide.co.uk town pages | DIR | 15–30 |
| Direct cremation specialists | funeralguide + provider sites; mostly national operators | SRCH | 2–5 |
| Natural & woodland burial grounds | naturaldeath.org.uk "find a natural burial site" (ANBG, 200+ UK sites) | DIR | 1–4 |
| Private cemeteries | ICCM (iccm-uk.com) + council cemetery pages | DIR | 2–6 |
| Private crematoria | FBCA (fbca.org.uk — 85% of UK cremation authorities) + cremation.org.uk | DIR | 1–3 |
| Repatriation specialists | NAFD directory repatriation filter + FIAT-IFTA members | DIR | 1–3 |
| Embalming specialists | BIE (bie.org.uk) has NO public member list — verify only. Source via funeral directors' in-house teams + trade suppliers | SRCH | 1–3 |
| Custom coffin makers | ffma.co.uk/members/ (Funeral Furnishing Manufacturers' Assoc — full Active Members list) | DIR | national, not per-area |
| Celebrants | Humanists UK; Institute of Civil Funerals (iocf.org.uk); Association of Independent Celebrants; Fellowship of Professional Celebrants; UK Society of Celebrants | DIR | 10–20 |
| Funeral musicians | Musicians' Union directory + crematorium recommended-organist lists | SRCH | 2–6 |
| Funeral catering & wakes | Local caterers + pub/hotel function rooms | SRCH | 5–15 |
| Funeral photographers | SWPP / BIPP / MPA member directories | DIR | 3–8 |
| Funeral videographers & livestream | Crematorium webcast providers (Obitus, Wesley Media) + local videographers | SRCH | 1–4 |
| Order-of-service printers | BPIF members + local print firms. **Search "funeral stationery printer", not the category name** | SRCH | 4–10 |
| Wake venues | **Search "funeral reception venue", "wake venue", "function room hire" — almost nobody markets as a "wake venue"**. Keep venues whose own site mentions funeral receptions; drop wedding-only specialists | SRCH | 8–20 |
| Funeral transport | Hearse/limousine hire + horse-drawn specialists; often via funeral directors | SRCH | 2–5 |
| Florists | Direct2Florist town pages + local press "best florists in <town>" + British Florist Association. **REJECT garden centres, nurseries, pet/aquatic/reptile shops, seed and fertiliser firms** — these dominate the wrong sources | DIR | 10–25 |
| Memorial masons & stonemasons | NAMM (namm.org.uk) + BRAMM registers + OpenStreetMap/Overpass + council "approved mason" lists | DIR | 4–12 |
| Memorial jewellery & cremation art | Ashes-into-glass/jewellery specialists; mostly national | SRCH | 1–4 |
| Ash scattering services | Scattering-at-sea/air specialists; mostly regional | SRCH | 1–3 |
| Memorial benches, trees & plaques | Memorial bench makers + council memorial schemes | SRCH | 2–6 |
| Probate solicitors | **solicitors.lawsociety.org.uk** Find a Solicitor, filter "wills, trusts and probate" by postcode | REG | 15–40 |
| Conveyancing solicitors | Law Society Find a Solicitor (conveyancing) + Council for Licensed Conveyancers register | REG | 15–40 |
| Probate accountants | ICAEW "Find a Chartered Accountant" + firms stating probate accreditation | REG | 5–15 |
| RICS chartered surveyors | RICS Find a Surveyor (postcode search) | REG | 8–20 |
| Estate clearance specialists | No trade body — search "probate house clearance" | SRCH | 4–10 |
| House clearance, removals & storage | bar.co.uk member directory (450+ BAR members) | DIR | 5–12 |
| Auction houses | SOFAA + NAVA Propertymark member lists | DIR | 2–6 |
| Garden maintenance (void property) | BALI / Association of Professional Landscapers members | DIR | 5–15 |
| Locksmiths (securing property) | locksmiths.co.uk (MLA — ~350 vetted Approved Companies) | DIR | 2–6 |
| Property security & insurance | Void-property security firms; no trade body | SRCH | 1–4 |
| Will writers & LPA drafters | ipw.org.uk membership directory (postcode search) + Society of Will Writers | DIR | 5–15 |
| Wills storage services | Will-storage providers + National Will Register partners | SRCH | 1–3 |
| Probate genealogists | iappr.org members + Finders/Fraser & Fraser | DIR | 1–3 |
| IHT planning & trust services | tactweb.org corporate members + firms' own sites stating STEP membership. **step.org is bot-blocked — never scrape it** | DIR | 4–10 |
| Bereavement & pension IFAs | FCA register + firms' own sites. **Beware coverage-vs-location: many list every area they'll travel to** | REG | 10–25 |
| Life insurance brokers | FCA register (insurance mediation) | REG | 5–15 |
| Equity release advisers | Equity Release Council member directory | DIR | 3–8 |
| Home care agencies | **CQC register** (cqc.org.uk) — filter by location and service type | REG | 10–30 |
| Domiciliary & live-in care | CQC register (domiciliary care agencies) | REG | 10–30 |
| Care home placement consultants | Small sector; search "care home placement advice" | SRCH | 1–3 |
| Private bereavement counsellors | BACP "Find a Therapist" (bereavement filter) + Cruse local branches | DIR | 5–15 |
| Children's bereavement specialists | Childhood Bereavement Network directory + local children's hospices | DIR | 1–4 |
| Kennels & catteries | Council animal-boarding licence registers + Pet Industry Federation | DIR | 5–15 |
| Pet rehoming agencies | Association of Dogs and Cats Homes members + local rescues | DIR | 2–6 |

**If an area returns well below the "expect" figure, you have missed the directory.** Go back to it and page
through properly before moving on. Report any area still short so it can be filled another way.

---

## QUALITY RULES

- **Never invent a firm.** Every row must trace to a listing you actually found.
- **ALWAYS capture the website — it is mandatory, not a target.** Resolve one for every firm by searching its
  name directly. **Never guess or construct a domain**, and never record "no website" without having searched.
- **Check before you post.** Pull what is already stored for the trade+area first and skip anything held. The
  store's key is name+area, so "Dillys" and "Dillys Bespoke Florist" are two rows — match on the DOMAIN, which
  is reliable, not on a stripped-down name, which is not.
- **Maximum 20 firms per postcode area.** Over that, keep the best 20: (1) accredited/registered members of
  the trade's body, (2) firms with their own website, (3) long-established, (4) the rest.
- **Businesses only** — not employees of a firm. Sole traders under a personal name ARE valid businesses
  (normal for celebrants, masons, photographers, counsellors).
- **Branches count as separate rows** — each is a real premises a family would walk into, and the marketplace
  lists by area.
- **Exclude chain-owned firms** where the trade has consolidators. Funeral: Co-op Funeralcare / East of England
  Co-op / Dignity / Funeral Partners. Masons: Co-operative Memorials, Memorial Group. **A large family-owned
  independent is NOT a chain** — Hunnaball (15 branches, family-run) stays in.
- **Free sources only. Never paid Google Places.**
- Record accreditation or membership in `notes` — it's the sales team's quality signal.

---

## WHAT NOT TO USE

**Companies House was removed as a source in August 2026.** Do not go back to it. It records company
REGISTRATIONS, not premises: it holds no website field at all (of 804 firms sourced that way, 2 had a
website), and its SIC codes bundle unrelated trades. Code 47760 is officially *"Retail sale of flowers,
plants, seeds, fertilizers, pet animals and pet food"*, so a request for florists correctly returned reptile
shops, aquatics centres, garden centres and fertiliser importers.

**Paid Google Places is not to be used.** Free sources only, always.

---

## HOW TO LOAD

POST to `https://postcodeprospector.netlify.app/.netlify/functions/kb`, `Content-Type: application/json`:

```json
{"action":"upsert","rows":[
  {"name":"Example Firm Ltd",
   "trade":"Celebrants",
   "area":"CO",
   "postcode":"CO1 1AA",
   "address":"1 High Street, Colchester",
   "website":"https://example.co.uk",
   "phone":"01206 000000",
   "email":"",
   "source":"jude-sourced",
   "status":"verified",
   "notes":"accreditation or useful detail"}
]}
```

- `name` and `area` are the only required fields. `area` = postcode-area letters only.
- `trade` must be the exact name from the table above, identical on every row.
- **De-duplicate on name+area before every POST** — two rows sharing name+area in one batch fail the
  **entire batch**.
- Max ~100 rows per POST. Re-running is safe: it updates rather than duplicating.

---

## CHECKING YOUR WORK

Open <https://postcodeprospector.netlify.app>, left sidebar **"Load from database"**, type the trade exactly
(capitalisation matters), untick **"Evaluate on import"**, click **⬇ Load stored firms into the grid**.
Leaving the Trade box blank loads every trade — always type it.
