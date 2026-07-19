// Postcode Prospector — VET & RANK.
// The AfterLife acceptance gate. Runs after classify + register-verify + enrich, over the
// surviving leads. For every lead it produces, best-first:
//   1. INDEPENDENCE (most important). AfterLife lists independents only.
//        · consolidator blocklist match by NAME or website DOMAIN            -> EXCLUDE
//        · corporate PSC from Companies House that is itself on the blocklist -> EXCLUDE (group-owned)
//        · a corporate PSC we can't place on the blocklist                    -> CHECK-PSC (show the parent)
//        · Claude reads the firm's own site text for an OWNERSHIP statement
//          ("part of X group", "subsidiary of X") and returns the quote        -> EXCLUDE on a clear finding
//   NOTE: being an "appointed representative of" a funeral-PLAN provider (Golden Charter, Golden
//   Leaves, Ecclesiastical, Dignity/Co-op plans…) is REQUIRED since 2022 to sell plans and is NEUTRAL
//   for independence — it is never an exclusion reason. Independence = ownership, not AR/network labels.
//   2. BEREAVEMENT FIT (0-10) — Claude scores relevance to bereaved families.
//   3. QUALITY (0-10) — reviews, credentials (Chartered/STEP/NAFD/SAIF/SRA/CQC…), years established.
//   4. VERDICT — APPROVE / REVIEW / CHECK-PSC / RESERVE / EXCLUDE (always with a reason).
//   5. APPROVE only — a DISTINCTIVE marketplace description that leads with what sets THIS firm
//      apart from others in its category (site facts only; generic filler is banned).
// Batched 25 at a time by the caller (like /classify). Reuses the stored Anthropic key.
// It does NOT crawl: the site text comes pre-fetched from /enrich (out.siteText), which keeps
// this single-Claude-call function comfortably inside the function timeout.

const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
const norm = s => (s || "").toLowerCase().replace(/\b(ltd|limited|llp|plc|the|and|&|co|group|partnership)\b/g, "").replace(/[^a-z0-9]/g, "");
function hostOf(url) {
  try { const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url); return u.hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

// blocklist entries arrive as {name, domain} (domain optional). Match a lead by either.
function blockHit(lead, blocklist) {
  const nm = norm(lead.name);
  const host = hostOf(lead.website);
  for (const b of blocklist) {
    const bn = norm(b.name);
    if (bn && bn.length > 3 && nm.includes(bn)) return b.name;
    if (b.domain) {
      const bd = String(b.domain).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
      if (bd && host && (host === bd || host.endsWith("." + bd))) return `${b.name} (${bd})`;
    }
  }
  return null;
}
// A corporate PSC (parent company from Companies House) that is itself a known consolidator.
function pscBlockHit(owners, blocklist) {
  for (const o of (owners || [])) {
    const on = norm(o);
    if (!on) continue;
    for (const b of blocklist) {
      const bn = norm(b.name);
      if (bn && bn.length > 3 && (on.includes(bn) || bn.includes(on))) return { owner: o, brand: b.name };
    }
  }
  return null;
}

// Known UK funeral-PLAN providers. Since July 2022 the FCA regulates pre-paid funeral plans, and an
// INDEPENDENT funeral director must be an Appointed Representative of a plan provider to sell them.
// So "appointed representative of <plan provider>" is NORMAL, REQUIRED, and says NOTHING about ownership.
// It must be treated as NEUTRAL for independence — independence is judged on ownership (Companies House
// PSC / parent), never on AR status or FCA-network labels.
const FUNERAL_PLAN_PROVIDERS = [
  "golden charter", "golden leaves", "ecclesiastical planning", "ecclesiastical",
  "pride planning", "pride & sons", "safe hands", "safehands", "avalon", "one life", "onelife",
  "open prepaid funerals", "openprepaid", "perfect choice", "sovereign", "distinct funeral plans",
  "capital life", "central england co-operative", "co-op funeral plan", "co-operative funeral plan",
  "coop funeral plan", "dignity funeral plan", "dignity pre", "age co", "over fifty", "sunlife",
  "great western", "shepherds friendly", "corinthian", "memoria plan"
];
// Ownership/control language — a genuine group finding. Deliberately SPECIFIC: bare "part of" must be
// followed by a group/holdings/company token, so incidental phrases ("part of our community", "proud
// to be part of the town") never mask a legitimate funeral-plan AR.
const OWNERSHIP_RE = /wholly owned subsidiary|subsidiary of|owned by|trading (?:name|as|style) of|division of|acquired by|member of the .{0,40}?group|part of (?:the )?[a-z][a-z0-9&.'\- ]{0,40}?(?:group|holdings|ltd|limited|plc|network|funerals?)\b/i;
// Is a quote/statement merely an AR-of-plan-provider disclosure (neutral), not an ownership statement?
function isPlanProviderAR(text) {
  const q = (text || "").toLowerCase();
  if (!/appointed representative|authorised representative|\bappointed rep\b|introducer appointed|funeral-plan ar|plan ar/.test(q)) return false;
  if (OWNERSHIP_RE.test(q)) return false;                        // "part of / owned by / subsidiary of" = real group finding
  return FUNERAL_PLAN_PROVIDERS.some(p => q.includes(p));
}

const SYSTEM = `You are the acceptance gate for AfterLife, a UK marketplace that introduces INDEPENDENT deathcare and later-life firms (funeral directors, IFAs, probate solicitors, celebrants, memorial masons, care providers) to bereaved families. You are given, per firm: its name, website domain, the searched category, review rating/count, any official-register verdict already obtained (FCA/CQC/FSA/SRA/Charity), and — crucially — the STRIPPED TEXT OF THE FIRM'S OWN WEBSITE. Judge from that evidence, never from the name alone.

Return, for each firm, a strict JSON object. Assess:

1. INDEPENDENCE — the single most important test, and it is strictly about OWNERSHIP: is the firm owned by, or part of, a national chain / network / franchise / consolidator group? Judge ONLY from OWNERSHIP evidence: explicit statements like "part of X group", "a X company", "proudly part of X", "member of the X group", "trading name of X Ltd", "wholly owned subsidiary of X", "acquired by X", or Companies House parent/PSC data. If you find such a clear OWNERSHIP statement, set independent=false and put the EXACT quote (verbatim, <=25 words) in group_quote. If the site clearly presents a locally/family/partner-owned independent, independent=true, group_quote="". If silent or unavailable, independent=null, group_quote="".
   CRITICAL — do NOT treat regulatory "appointed representative" (AR) status as an ownership signal. Since July 2022 the FCA regulates pre-paid funeral plans, and an INDEPENDENT funeral director is REQUIRED to be an "appointed representative of" a funeral-PLAN provider (Golden Charter, Golden Leaves, Ecclesiastical Planning, Pride Planning, Safe Hands, Avalon, and the Dignity / Co-op plan schemes, etc.) simply to sell regulated funeral plans. "Appointed representative of Golden Charter" (or any plan provider) is NORMAL and says NOTHING about ownership — it is NEUTRAL. NEVER set independent=false or write a group_quote because of an AR-of-a-plan-provider statement. Likewise ignore generic FCA-network labels; only an SJP-style AR where the principal is the OWNER/controller counts, and even then rely on ownership evidence.
   Note for funeral directors: Dignity and Co-op OWN many firms trading under local family names — a warm "family firm since 1890" claim does NOT prove independence; only an explicit ownership statement (or PSC data) settles it. But being an AR of Dignity's or Co-op's funeral-PLAN scheme is just plan-selling, not ownership — treat that as neutral.

2. FIT (0-10) — relevance to BEREAVED FAMILIES specifically. Reward, per trade: IFA -> inheritance tax, estate/probate planning, trust & estate practitioner, later-life/care-fees planning, powers of attorney; funeral director -> own chapel of rest, out-of-hours/24h, faith & cultural provision, prepaid plans, private ambulance; solicitor -> probate, estate administration, wills, LPAs, contentious probate; celebrant -> funeral/memorial ceremonies (NOT weddings only). A firm whose site shows none of this for grieving families scores low even if reputable.

3. QUALITY (0-10) — reviews (rating AND count), credentials named on the site (Chartered, Certified, STEP, NAFD, SAIF, BIFD, SRA-regulated, Law Society, CQC rating, FCA authorised, years/decades established, awards). Thin/no-evidence sites score low. TRADE-BODY MEMBERSHIP (the "trade-body:" field — e.g. SAIF, NAFD, STEP) is verified independent evidence of a genuine, category-clean firm: treat it as a real credential and a quality signal, and note it. A firm "found via:" a trade-body directory is category-verified — do not doubt that it is the right trade.

4. VERDICT — one of APPROVE, REVIEW, RESERVE, EXCLUDE (do NOT output CHECK-PSC; the caller sets that from Companies House data).
   · EXCLUDE — independent=false with a group_quote, OR clearly the wrong trade / not deathcare-relevant at all.
   · APPROVE — independent (true or null-but-no-red-flags) AND fit>=6 AND quality>=5 AND genuinely useful to a grieving family.
   · REVIEW  — promising but something needs a human eye (independence unclear, mid scores, register flagged).
   · RESERVE — independent and legitimate but weak fit or thin quality; a fallback, not a first pick.

5. credentials — a short comma-separated line of the concrete credentials/accreditations you actually saw on the site (e.g. "Chartered, STEP, 40+ yrs"). "" if none.

6. description — ONLY when verdict is APPROVE, and ONLY from facts on the firm's OWN site text. Two tests it MUST pass: the FIRM would be happy to see it published, and a BEREAVED FAMILY learns something that helps them choose. FORMAT: 45–75 words, normally TWO sentences. Sentence 1 = who they are (how long established / how many generations) and the TOWNS they serve (name the actual towns, never "their local area"). Sentence 2 = the SPECIFIC services and facilities they offer. Lead with what is DISTINCTIVE, not the category. Be concrete: services (religious and non-religious funerals, direct cremation, woodland burial, repatriation, prepaid plans, forward planning); facilities (chapels of rest — how many/where; own fleet; home visits; dedicated memorials service; lady and gentleman funeral directors); heritage in the firm's own terms ("sixth-generation", "over 160 years"); availability plainly ("24 hours a day, seven days a week"). Priority if over-long: heritage/generations → towns → 24-hr availability → distinctive services → facilities → anything genuinely unusual.
   HARD RULES: (a) Every fact from the firm's own site — NEVER invent a date, town, faith, price, service or facility. (b) NEVER write a sentence whose only content is category, area or accreditation — BANNED e.g. "X is an independent funeral director serving their local community and is a member of SAIF and NAFD"; those badges are shown as chips above the text. (c) No superlatives (best/leading/trusted/award-winning) unless the site names a specific award. (d) Keep credentials OUT of the description — they live in the credentials array. (e) If the site yields NOTHING beyond name, category, area and accreditations, set description to exactly "NO_CONTENT" — a blank profile beats filler. If verdict is not APPROVE, description="".

Respond with ONLY a JSON array, no markdown, no preamble, one object per input firm IN ORDER:
[{"i":0,"independent":true,"group_quote":"","fit":8,"quality":7,"verdict":"APPROVE","reason":"independent funeral director, own chapels, woodland burial + repatriation","credentials":"NAFD, est. 1901","description":"P.G. Oxley Funeral Directors is a sixth-generation family business serving Walton-on-the-Naze, Frinton-on-Sea, Clacton-on-Sea and surrounding areas, established for over 160 years. They offer 24-hour availability, private chapels of rest at three locations, home visits for arrangements, and a full range of services including woodland burials, repatriation, and prepaid funeral plans."}]
reason: under 18 words. The description must LEAD with what is distinctive (heritage, towns, specific services), never a generic category opener, and pass both tests. Be decisive and strict.`;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const apiKey = clean(process.env.ANTHROPIC_API_KEY || body.anthropicKey);
    const request = (body.request || "").slice(0, 400);
    const items = (body.items || []).slice(0, 15);
    if (!items.length) return { statusCode: 200, headers, body: JSON.stringify({ results: [] }) };

    // Normalise the (editable) consolidator blocklist -> [{name, domain}].
    const blocklist = (body.blocklist || []).map(b => (typeof b === "string" ? { name: b, domain: "" } : { name: b.name || "", domain: b.domain || "" }))
      .filter(b => b.name || b.domain);

    // ---- deterministic independence overrides (blocklist + Companies House PSC) ----
    const pre = items.map(it => {
      const hit = blockHit(it, blocklist);
      if (hit) return { hard: true, verdict: "EXCLUDE", reason: `On consolidator blocklist — ${hit}`, independent: false };
      const psc = pscBlockHit(it.corporateOwners, blocklist);
      if (psc) return { hard: true, verdict: "EXCLUDE", reason: `Group-owned — PSC ${psc.owner} is ${psc.brand}`, independent: false, pscParent: psc.owner };
      if (Array.isArray(it.corporateOwners) && it.corporateOwners.length) return { hard: false, verdict: "CHECK-PSC", pscParent: it.corporateOwners[0] };
      return { hard: false };
    });

    // Only send non-hard-excluded firms to Claude (saves tokens; hard excludes need no reasoning).
    const toScore = items.map((it, i) => ({ it, i })).filter(x => !pre[x.i].hard);

    let verdicts = [];
    if (apiKey && toScore.length) {
      const list = toScore.map(({ it }, k) =>
        `${k}. ${it.name} | trade sought: ${it.aiType || "?"} | web: ${hostOf(it.website) || "none"} | rating ${it.rating ?? "?"} (${it.reviews || 0} reviews)` +
        `${it.memberships ? ` | trade-body: ${it.memberships}` : (it.register ? ` | trade-body: ${it.register}` : "")}${(it.sources && it.sources.length) ? ` | found via: ${it.sources.join("+")}` : ""}` +
        `${(it.fca || it.reg) ? ` | register: ${it.fca || it.reg}` : ""}${it.regStatus ? ` | small-print: ${it.regStatus}` : ""}` +
        `${(it.planAR || it.planProvider) ? ` | plan-AR: ${it.planProvider || "yes"} (NEUTRAL — required to sell plans, NOT an ownership tie)` : ""}\n` +
        `   SITE TEXT: ${(it.siteText || "").slice(0, 1500) || "(no site text — score conservatively; independence=null)"}`
      ).join("\n\n");

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          system: SYSTEM,
          messages: [{ role: "user", content: `AfterLife is recruiting: "${request}"\n\nVet & rank these ${toScore.length} firms:\n\n${list}` }]
        })
      });
      const data = await r.json();
      if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: data.error.message }) };
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g, "").trim();
      try { verdicts = JSON.parse(text); }
      catch { const m = text.match(/\[[\s\S]*\]/); if (m) { try { verdicts = JSON.parse(m[0]); } catch {} } }
    }

    // map Claude's local index (k) back to the original item index
    const byLocal = {};
    (verdicts || []).forEach(v => { if (v && typeof v.i === "number") byLocal[v.i] = v; });

    const results = items.map((it, i) => {
      const p = pre[i];
      const base = { i, name: it.name, verdict: "REVIEW", fit: 0, quality: 0, reason: "", credentials: "", description: "", independent: null, groupQuote: "", pscParent: p.pscParent || "" };

      if (p.hard) return { ...base, verdict: p.verdict, reason: p.reason, independent: p.independent };

      const localIdx = toScore.findIndex(x => x.i === i);
      const v = localIdx >= 0 ? byLocal[localIdx] : null;
      if (v) {
        base.fit = Math.max(0, Math.min(10, Number(v.fit) || 0));
        base.quality = Math.max(0, Math.min(10, Number(v.quality) || 0));
        base.reason = String(v.reason || "").slice(0, 160);
        base.credentials = String(v.credentials || "").slice(0, 160);
        base.independent = v.independent === true ? true : v.independent === false ? false : null;
        base.groupQuote = String(v.group_quote || "").slice(0, 220);
        base.verdict = ["APPROVE", "REVIEW", "RESERVE", "EXCLUDE"].includes(v.verdict) ? v.verdict : "REVIEW";
        {const d = String(v.description || "").trim(); base.description = /^NO_?CONTENT\.?$/i.test(d) ? "" : d.slice(0, 1000);}  // NO_CONTENT → blank, no filler
      } else if (apiKey) {
        base.reason = "no verdict returned — review manually";
      } else {
        base.reason = "no Anthropic key — scored 0, review manually";
      }

      // GUARD: an "appointed representative of a funeral-PLAN provider" is required & neutral —
      // never let it drive an exclusion. Independence rests on ownership (PSC/parent, handled above).
      // Catches the case where the model still (wrongly) flagged a plan-AR as a group finding.
      const arContext = base.groupQuote || it.regStatus || (it.planProvider ? ("appointed representative of " + it.planProvider) : "");
      if (base.independent === false && (it.planAR || isPlanProviderAR(arContext))) {
        base.independent = null;
        base.groupQuote = "";
        base.reason = (String(base.reason || "").replace(/not independent[^.]*\.?/i, "").trim() +
          " — AR of a funeral-plan provider (neutral; independence is judged on ownership)").replace(/^—\s*/, "").trim();
        if (base.verdict === "EXCLUDE") base.verdict = "REVIEW";   // clean re-run will score it APPROVE with a description
      }
      // A genuine OWNERSHIP disclosure -> exclude, keeping scores for the record.
      if (base.independent === false && base.groupQuote) {
        base.verdict = "EXCLUDE";
        base.reason = `Not independent — "${base.groupQuote}"`;
        base.description = "";
      }
      // A corporate PSC we couldn't place on the blocklist -> never auto-exclude; flag for a human.
      if (!p.hard && p.pscParent && base.verdict !== "EXCLUDE") {
        base.verdict = "CHECK-PSC";
        base.reason = `Corporate PSC: ${p.pscParent} — confirm independence. ${base.reason}`.trim();
        base.description = "";
      }
      if (base.verdict !== "APPROVE") base.description = "";
      return base;
    });

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
