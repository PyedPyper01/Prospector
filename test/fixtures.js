#!/usr/bin/env node
/* Postcode Prospector — REGRESSION FIXTURE SUITE.
 * Every fixture below is a bug we hit and fixed on 2026-07-16. Runs with NO API calls and NO cost.
 * Run: node test/fixtures.js   (exits non-zero if any fixture regresses).
 *
 * ⚠ KEEP THE PREDICATES BELOW IN SYNC with the live logic:
 *   isChainDomain / CHAIN_NAME_PATTERNS / nameChainHit / wrongCategory / detectGroupIsGroup  → index.html
 *   selectEmails / okEmail / BAD_LOCAL                                                        → netlify/functions/enrich.js
 *   chMatchConfidence                                                                         → netlify/functions/companieshouse.js
 * If you change the live logic, update these copies and add a fixture for the case you changed.
 */
let PASS = 0, FAIL = 0;
const eq = (got, exp, msg) => { const ok = JSON.stringify(got) === JSON.stringify(exp); (ok ? PASS++ : FAIL++); console.log(`  ${ok ? "✅" : "❌ FAIL"} ${msg}${ok ? "" : `\n        got ${JSON.stringify(got)}  expected ${JSON.stringify(exp)}`}`); };

/* ───────── copies of the live pure predicates ───────── */
const normTxt = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const nameKey = s => (s || "").toLowerCase().replace(/&/g, "and").replace(/\btrading\s+as\b.*$/, "").replace(/\s+[-–—]\s+.*$/, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\b(ltd|limited|llp|plc|the|co|company|funeral directors?|funerals?|funeralcare|services?|service|group|and|sons?|son)\b/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 14);
const CHAIN_EXTRA_DOMAINS = ['funeralpartners.co.uk','dignityfunerals.co.uk','dignityuk.co.uk','dignitymemorial.com','cpjfield.co.uk','memoria.co.uk','coop.co.uk'];
const CHAIN_DOMAIN_RE = /(?:^|\.)(?:dignity|funeralpartners|cpjfield|westerleigh|purecremation|pure-cremation|farewill|fenixfuneral|simplicitycremations?|coopfunerals?|cooperativefuneral|co-operativefuneral)/i;
const isChainDomain = d => { if (!d) return false; d = String(d).toLowerCase().replace(/^www\./, ""); if (CHAIN_DOMAIN_RE.test(d)) return true; if (d === "coop.co.uk" || d === "memoria.co.uk") return true; return CHAIN_EXTRA_DOMAINS.includes(d); };
const CHAIN_NAME_PATTERNS = [
  { re: /\bco-?operative\b|\bco-?op\b/i, label: "Co-op" }, { re: /\bdignity\b/i, label: "Dignity" },
  { re: /\bfuneral\s+partners\b/i, label: "Funeral Partners" }, { re: /\bmemoria\b/i, label: "Memoria" },
  { re: /\bwesterleigh\b/i, label: "Westerleigh" }];
const nameChainHit = name => { for (const p of CHAIN_NAME_PATTERNS) if (p.re.test(name || "")) return p.label; return null; };
const CATEGORY_NEGATIVES = { funeral: { neg: /\bcrematori|\bcemeter(y|ies)|\bburial ground|\bmemorial park|\bgarden of remembrance|\bbereavement services\b|\bregister office|\bmortuary\b/i, pos: /funeral (director|home|service)|undertaker|funerals\b|funeralcare/i, label: "crematorium/cemetery" } };
const wrongCategory = (name, catKey) => { const c = CATEGORY_NEGATIVES[catKey]; if (!c) return null; const n = (name || "").toLowerCase(); return (c.neg.test(n) && !c.pos.test(n)) ? c.label : null; };
// group detection: is a domain a GENUINE group (≥2 differently-named firms across ≥2 areas)?
function isGroup(domain, names, areasCount) {
  const root = domain.split(".")[0].replace(/^(the|my)/, "").replace(/(funerals?|funeraldirectors?|group|holdings?|co|ltd)$/, "");
  const r5 = root.slice(0, 5); const distinct = [...new Set(names.map(nameKey))].filter(Boolean);
  const foreign = distinct.filter(nk => r5.length >= 3 ? (!nk.includes(r5) && !root.includes(nk.slice(0, 5))) : true);
  return foreign.length >= 2 && areasCount >= 2;
}
// email selection (mirror of enrich.js)
const BAD_LOCAL = /(?:^|[.\-_])(?:section|contactsection|email\d?|emailfield|jsemail|field\d|node\d|item\d)(?:[.\-_]|$)|-email-|section-email|contact-section/i;
const GENERIC_WEBMAIL = new Set(["gmail.com", "outlook.com", "hotmail.com"]);
const GENERIC_LOCAL = /^(info|enquiries|enquiry|hello|office|admin|mail|contact|reception)(\d|@|$)/i;
const regDomain = h => { h = String(h || "").toLowerCase().replace(/^www\./, ""); const p = h.split("."); if (p.length >= 3 && /^(co|org|me|ltd|plc|net)$/.test(p[p.length - 2])) return p.slice(-3).join("."); return p.slice(-2).join("."); };
function selectEmails(all, siteHost, hints) {
  const base = regDomain(siteHost); const own = [], web = [];
  for (const e of all) { if (BAD_LOCAL.test(e.split("@")[0] || "")) continue; const dom = (e.split("@")[1] || "").toLowerCase(); if (regDomain(dom) === base || dom.endsWith("." + base)) own.push(e); else if (GENERIC_WEBMAIL.has(dom)) web.push(e); }
  let chosen = own;
  if (own.length > 3) { const toks = (hints || []).flatMap(h => String(h || "").toLowerCase().split(/[^a-z0-9]+/)).filter(t => t.length >= 3); const branch = own.filter(e => { const s = e.toLowerCase().replace(/[^a-z0-9]/g, ""); return toks.some(t => s.includes(t)); }); const generic = own.filter(e => GENERIC_LOCAL.test(e.split("@")[0])); chosen = branch.length ? branch : (generic.length ? generic : own); }  // keep own-domain emails rather than dropping to [] (enrich.js fix)
  return [...new Set([...chosen, ...web])].slice(0, 3);
}
// CH match confidence (mirror of companieshouse.js)
function chMatchConfidence(queryName, chTitle, firmPostcode, chAddressSnippet) {
  const norm = s => String(s || "").toLowerCase().replace(/\b(ltd|limited|llp|plc|the|co|company|and|&|sons?|funeral|directors?|services?|group)\b/g, "").replace(/[^a-z0-9]/g, "");
  const q = norm(queryName), t = norm(chTitle);
  const nameClose = q.length >= 3 && t.length >= 3 && (t.startsWith(q.slice(0, 8)) || q.startsWith(t.slice(0, 8)) || t.includes(q) || q.includes(t));
  const pc = String(firmPostcode || "").toUpperCase().replace(/\s/g, ""); const snip = String(chAddressSnippet || "").toUpperCase().replace(/\s/g, "");
  const pcFull = pc && snip.includes(pc); const pcDistrict = pc && snip.includes(pc.replace(/\d[A-Z]{2}$/, ""));
  return (nameClose && (pcFull || pcDistrict)) ? "high" : (nameClose ? "medium" : "low");
}
// exact canonical consolidator brand (fix B) — high-confidence identity
const CANONICAL_BRANDS = [
  { re: /\bco-?op(?:erative)?\s+funeral\s?care\b/i, label: "Co-op Funeralcare" },
  { re: /\bthe\s+co-?operative\s+funeral(?:\s?care)?\b/i, label: "The Co-operative Funeralcare" },
  { re: /\bco-?op(?:erative)?\s+funeral\s+service/i, label: "Co-op Funeral Service" },
  { re: /\bdignity\s+funerals?\b/i, label: "Dignity Funerals" }, { re: /\bfuneral\s+partners\b/i, label: "Funeral Partners" }];
const canonicalBrandHit = name => { for (const b of CANONICAL_BRANDS) if (b.re.test(name || "")) return b.label; return null; };
// confirmed-chain registry (mirror of index.html) — seeded subset
const REGISTRY = [{ name: "Titford", parent: "Dignity" }, { name: "Francis Chappell", parent: "Dignity" }, { name: "W H Scott", parent: "Dignity" }, { name: "J H Kenyon", parent: "Dignity" }, { name: "W H Shephard", parent: "East of England Co-op" }].map(e => ({ ...e, nk: nameKey(e.name) }));
const confirmedChainHit = name => { const nk = nameKey(name); if (nk.length < 4) return null; return REGISTRY.find(e => nk === e.nk || nk.startsWith(e.nk) || (e.nk.length >= 6 && e.nk.startsWith(nk) && nk.length >= 6)) || null; };
// deletion gate: HIGH-confidence identity deletes (chain-domain / chain-email / ownership / canonical brand / registry)
function chainVerdict({ website, emails = [], independent = "", saif = false, name = "" }) {
  const wd = website ? regDomain(website.replace(/^https?:\/\//, "")) : "";
  const chainEmails = emails.filter(e => isChainDomain((e.split("@")[1] || "")));
  const ownEmails = emails.filter(e => !isChainDomain((e.split("@")[1] || "")));
  const disclosure = /^N\b/.test(independent);
  if (wd && isChainDomain(wd)) return { verdict: "EXCLUDE", trigger: "chain-domain" };
  if (chainEmails.length && !ownEmails.length) return { verdict: "EXCLUDE", trigger: "chain-email" };
  if (disclosure) return { verdict: "EXCLUDE", trigger: "ownership-disclosure" };
  if (canonicalBrandHit(name)) return { verdict: "EXCLUDE", trigger: "chain-brand" };
  if (confirmedChainHit(name)) return { verdict: "EXCLUDE", trigger: "confirmed-chain" };
  if (!saif && nameChainHit(name)) return { verdict: "KEEP", flag: "SUSPECTED CHAIN" };
  return { verdict: "KEEP" };
}

/* ───────── FIXTURES ───────── */
console.log("\n1. Enfield Crematorium + CMG email blob → row rejected by wrong-category + group-domain; selectEmails keeps own-domain only (cross-org + artefacts dropped)");
eq(wrongCategory("Enfield Crematorium & Cemetery", "funeral"), "crematorium/cemetery", "Enfield Crematorium → wrong-category (row rejected before its emails matter)");
const cmgLeak = ["exeteranddevon.crematorium@thecmg.co.uk","eastlondon.crematorium@thecmg.co.uk","southlondon.crematorium@thecmg.co.uk","beckenham.crematorium@thecmg.co.uk","randallspark.crematorium@thecmg.co.uk","contact-section-email-3@thecmg.co.uk","kingston.admissions@achievingforchildren.co.uk"];
// enrich.js fix: selectEmails no longer drops verified own-domain emails to [] (that lost real named-staff
// addresses on legit firms). For a group page it now returns own-domain addresses — but the CMG ROW itself is
// still excluded upstream by wrong-category (above) + group-domain detection (#2) + registry (#11), so nothing leaks.
const picked = selectEmails(cmgLeak, "www.thecmg.co.uk", ["Enfield Crematorium", "Enfield"]);
eq(picked.length > 0 && picked.every(e => e.endsWith("@thecmg.co.uk")), true, "selectEmails keeps ONLY own-domain (thecmg) addresses");
eq(picked.includes("kingston.admissions@achievingforchildren.co.uk"), false, "cross-organisation email (achievingforchildren) dropped");
eq(picked.some(e => /contact-section/.test(e)), false, "HTML-artefact local-part dropped");

console.log("\n2. thecmg.co.uk across areas → CONSOLIDATOR group DETECTED");
eq(isGroup("thecmg.co.uk", ["Enfield Crematorium", "East London Crematorium", "Beckenham Crematorium"], 3), true, "thecmg = group");

console.log("\n3. westcoe / hunnaball across areas → MULTI-BRAND INDEPENDENT (group detected → merge+keep, NOT auto-delete)");
eq(isGroup("westcoe.co.uk", ["West & Coe", "H L Hawes & Son", "A G Butler & Son"], 3), true, "westcoe = group (→ merge+keep)");
eq(chainVerdict({ website: "https://hlhawes.co.uk", emails: ["office@westcoe.co.uk"], name: "H L Hawes & Son" }).verdict, "KEEP", "group member NOT auto-deleted (westcoe not on blocklist)");

console.log("\n4. levertons / tcribb / albin / afrance across areas → ONE firm's own branches, NOT a group");
eq(isGroup("levertons.co.uk", ["Leverton & Sons Fortis Green", "Leverton & Sons Golders Green"], 2), false, "Leverton branches ≠ group");
eq(isGroup("tcribb.co.uk", ["T Cribb & Sons", "T CRIBB & SONS Funeral Directors Monumental Masons Barking Ilford"], 3), false, "T Cribb branches ≠ group");
eq(isGroup("albins.co.uk", ["F A Albin and Sons Ltd", "Albin and Hitchcock", "F.A. Albin Mottingham"], 3), false, "Albin branches ≠ group");
eq(isGroup("afrance.co.uk", ["A France & Son (Kings Cross)", "A France & Son (Holborn) Ltd"], 3), false, "A France branches ≠ group");

console.log("\n5. 'Cooper & Sons' / 'Smith Memorials' → must NOT match coop / memoria");
eq(nameChainHit("Cooper & Sons"), null, "Cooper ≠ Co-op");
eq(nameChainHit("Coopers Funeral Service"), null, "Coopers ≠ Co-op");
eq(nameChainHit("Smith Memorials"), null, "Memorials ≠ Memoria");
eq(nameChainHit("Memorial Woodlands"), null, "Memorial ≠ Memoria");
eq(nameChainHit("Co-op Funeralcare"), "Co-op", "Co-op Funeralcare IS Co-op");
eq(nameChainHit("Dignity Funerals"), "Dignity", "Dignity IS Dignity");

console.log("\n6. F A Albin & Sons typed 'cemetery' by Google → NOT wrong-category (name-based only)");
eq(wrongCategory("F A Albin & Sons", "funeral"), null, "FA Albin (name has no crematorium/cemetery word) → kept");

console.log("\n7. Titford with a dignityfunerals.co.uk website → EXCLUDED on hard evidence");
eq(chainVerdict({ website: "https://www.dignityfunerals.co.uk/titford", emails: [], name: "Titford Funeral Service" }).trigger, "chain-domain", "Titford on dignity domain → chain-domain exclude");
eq(chainVerdict({ website: "https://titford.co.uk", emails: ["titford@dignityfunerals.co.uk"], name: "Titford" }).trigger, "chain-email", "Titford only-email @dignity → chain-email exclude");

console.log("\n8. Low-confidence Companies House name match → may enrich, must NOT delete");
eq(chMatchConfidence("T Cribb & Sons", "TCRIBB HOLDINGS LTD", "IG11 0TX", "SUITE 4, MANCHESTER M1 2AB"), "medium", "name-close but wrong postcode → medium (not high) → not deletable");
eq(chMatchConfidence("Smith Funerals", "SMITH FUNERALS LTD", "CO1 1AA", "HIGH ST, COLCHESTER CO1 1AA"), "high", "name+postcode corroborated → high");
eq(chMatchConfidence("Jones & Sons", "TOTALLY DIFFERENT CO LTD", "N1 1AA", "LEEDS LS1 1AA"), "low", "no name/postcode match → low");
// a medium/low CH match with a consolidator PSC must NOT set independent='N', so chainVerdict keeps it:
eq(chainVerdict({ website: "https://tcribb.co.uk", emails: ["info@tcribb.co.uk"], independent: "", chConfidence: "medium", saif: true, name: "T Cribb & Sons" }).verdict, "KEEP", "SAIF firm w/ low-conf CH → KEPT (not deleted)");

console.log("\n9. A firm in BOTH kept and excluded → assertion must catch it");
function bothListsAssertion(kept, dropped) { const k = new Set(kept.map(x => normTxt(x.name) + "|" + x.area)); return dropped.filter(d => k.has(normTxt(d.name) + "|" + d.area)); }
eq(bothListsAssertion([{ name: "F A Albin", area: "SE" }], [{ name: "F A Albin", area: "SE" }]).length, 1, "same company+area in both → assertion fires");
eq(bothListsAssertion([{ name: "F A Albin", area: "SE" }], [{ name: "F A Albin", area: "E" }]).length, 0, "different areas → OK (separate slots)");

console.log("\n10. Exact canonical brand → HARD-excluded; token buried in an independent name → KEPT (fix B)");
eq(chainVerdict({ name: "Co-op Funeralcare, Colchester" }).trigger, "chain-brand", "'Co-op Funeralcare' → chain-brand exclude");
eq(chainVerdict({ name: "The Co-operative Funeralcare" }).trigger, "chain-brand", "'The Co-operative Funeralcare' → exclude");
eq(chainVerdict({ name: "Dignity Funerals Ltd" }).trigger, "chain-brand", "'Dignity Funerals' → exclude");
eq(chainVerdict({ name: "Cooper & Sons" }).verdict, "KEEP", "'Cooper & Sons' → KEPT (not a canonical brand)");
eq(chainVerdict({ name: "Coopers Funeral Service" }).verdict, "KEEP", "'Coopers Funeral Service' → KEPT");
eq(chainVerdict({ name: "Smith Memorials" }).verdict, "KEEP", "'Smith Memorials' → KEPT");

console.log("\n11. Registry-listed subsidiary → HARD-excluded with metered OFF (no domain/crawl evidence)");
eq(chainVerdict({ name: "Titford Funeral Directors, Frinton-on-Sea", website: "", emails: [] }).trigger, "confirmed-chain", "Titford (registry) → excluded, metered off");
eq(chainVerdict({ name: "Francis Chappell & Sons", website: "", emails: [] }).trigger, "confirmed-chain", "Francis Chappell (registry) → excluded");
eq(chainVerdict({ name: "J H Kenyon", website: "", emails: [] }).trigger, "confirmed-chain", "J H Kenyon (registry) → excluded");
eq(chainVerdict({ name: "Titfield Independent Funerals" }).verdict, "KEEP", "'Titfield' (not Titford) → KEPT (no false registry hit)");
eq(chainVerdict({ name: "W.H. Shephard Funeral Service", website: "", emails: [] }).trigger, "confirmed-chain", "W.H. Shephard (East of England Co-op) → excluded via registry");

console.log("\n12. Merged multi-brand row → labelled with the PARENT (domain root), not a satellite brand");
// mirror of relabelMergedRows: pick the merged name matching the website-domain root, else most frequent
function relabelParent(website, names) {
  const distinct = [...new Set(names)]; if (distinct.length < 2) return names[0];
  const root = (regDomain(String(website).replace(/^https?:\/\//, "")).split(".")[0] || "").replace(/^(the|my)/, "").replace(/(funerals?|group|holdings?|co|ltd)$/, "");
  if (root.length >= 4) { const r5 = root.slice(0, 5); const p = distinct.find(n => { const nk = nameKey(n); return nk && (nk.includes(r5) || root.includes(nk.slice(0, 5))); }); if (p) return p; }
  const freq = {}; names.forEach(n => freq[n] = (freq[n] || 0) + 1); return distinct.slice().sort((a, b) => (freq[b] - freq[a]) || (a.length - b.length))[0];
}
eq(/hunnaball/i.test(relabelParent("https://www.hunnaball.co.uk", ["Geo Paskell of Manningtree", "Janet C Davies of Kelvedon", "Hunnaball of Colchester", "J K May of West Mersea"])), true, "Hunnaball merge → labelled 'Hunnaball…' (parent), not 'Geo Paskell'");
eq(/west/i.test(relabelParent("https://westcoe.co.uk", ["West & Coe Trading as Harwich", "West & Coe Funeral Directors"])), true, "West & Coe merge → labelled 'West & Coe'");

console.log("\n13. Register-supply merge: both→one row 'both'; register-miss still appears; discovery-not-in-register → 'discovery'");
// mirror of foldInRegister's core: match register rows to discovery leads per area, mark source
function foldInRegister(leads, register) {
  leads.forEach(l => { if (!l.source) l.source = "discovery"; });
  const areas = new Set(leads.map(l => (l.area || "").toUpperCase()));
  register.forEach(r => {
    const area = (r.POSTCODE_AREA || "").toUpperCase(); if (!areas.has(area)) return;
    if (/chain/i.test(r.INDEPENDENT_OR_CHAIN || "") || (r.PARENT_GROUP || "").trim()) return; // consolidators excluded
    const rnk = nameKey(r.COMPANY), rdom = r.WEBSITE ? regDomain(r.WEBSITE.replace(/^https?:\/\//, "")) : "";
    const m = leads.find(l => (l.area || "").toUpperCase() === area && (
      (rdom && l.website && regDomain(l.website.replace(/^https?:\/\//, "")) === rdom) ||
      nameKey(l.name) === rnk || (nameKey(l.name).length >= 6 && rnk.startsWith(nameKey(l.name))) || (rnk.length >= 6 && nameKey(l.name).startsWith(rnk))));
    if (m) { m.source = m.source === "register" ? "register" : "both"; m.saifMember = r.SAIF_MEMBER; }
    else leads.push({ area, name: r.COMPANY, website: r.WEBSITE, source: "register", saifMember: r.SAIF_MEMBER });
  });
  return leads;
}
{
  const disc = [
    { area: "CO", name: "Hunnaball of Colchester", website: "https://hunnaball.co.uk" }, // in both
    { area: "CO", name: "Last Ride Funerals", website: "https://lastride.co.uk" },        // discovery only
  ];
  const reg = [
    { COMPANY: "Hunnaball of Colchester", POSTCODE_AREA: "CO", WEBSITE: "https://www.hunnaball.co.uk", SAIF_MEMBER: "Y", INDEPENDENT_OR_CHAIN: "independent" }, // both
    { COMPANY: "A.R Clarke Funerals", POSTCODE_AREA: "CO", WEBSITE: "https://arclarke.co.uk", SAIF_MEMBER: "Y", INDEPENDENT_OR_CHAIN: "independent" },          // register miss
    { COMPANY: "Titford Funeral Directors", POSTCODE_AREA: "CO", WEBSITE: "https://dignityfunerals.co.uk/titford", PARENT_GROUP: "Dignity", INDEPENDENT_OR_CHAIN: "chain" }, // consolidator — excluded
  ];
  const merged = foldInRegister(disc, reg);
  const hun = merged.filter(l => /hunnaball/i.test(l.name));
  eq(hun.length, 1, "firm in both sources → exactly ONE row");
  eq(hun[0] && hun[0].source, "both", "…marked 'both'");
  eq(hun[0] && hun[0].saifMember, "Y", "…SAIF flag carried from register");
  eq(!!merged.find(l => /a\.?r clarke/i.test(l.name) && l.source === "register"), true, "register firm Prospector missed → still appears, source 'register'");
  eq(merged.find(l => /last ride/i.test(l.name)).source, "discovery", "discovery firm not in register → 'discovery'");
  eq(!!merged.find(l => /titford/i.test(l.name)), false, "register consolidator (Titford/Dignity) → excluded, not added");
}

console.log("\n14. Manual supply: forgiving parse + required fields; manual→'manual', both→one 'both' row, discovery stays 'discovery'; verified rows immune; category maps from CATEGORY");
// mirrors of the live manual-supply logic in index.html
function normManualRow(r) {
  const idx = {}; for (const k in r) idx[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = r[k];
  const g = (...keys) => { for (const k of keys) { const v = (idx[k] || "").trim(); if (v) return v; } return ""; };
  const o = {
    COMPANY: g("company", "businessname", "business", "name", "supplier", "firm"),
    CONTACT_NAME: g("contactname", "contact", "person", "owner"),
    CATEGORY: g("category", "cat", "trade", "service", "type"),
    AREA: g("area", "postcodearea", "pcarea"), DISTRICT: g("district", "outcode"),
    TOWN: g("town", "city", "location"), WEBSITE: g("website", "web", "url", "site"),
    PHONE: g("phone", "tel", "telephone", "mobile", "number", "phonenumber"),
    EMAIL: g("email", "emailaddress", "mail"), NOTES: g("notes", "note", "comment", "comments", "info")
  };
  const pc = g("postcode");
  if (!o.AREA) { const src = o.DISTRICT || pc; o.AREA = (src.match(/^[A-Za-z]{1,2}/) || [""])[0]; }
  o.AREA = (o.AREA || "").toUpperCase().replace(/[^A-Z]/g, "");
  return o;
}
const MANUAL_CAT_RULES = [[/celebrant|officiant/, "celebrants"], [/funeral director|undertaker/, "funeral-directors"], [/ash scatter/, "ash-scattering"]];
const guessCat = t => { t = (t || "").toLowerCase(); for (const [re, id] of MANUAL_CAT_RULES) if (re.test(t)) return id; return ""; };
function foldInManual(leads, manual) {
  leads.forEach(l => { if (!l.source) l.source = "discovery"; });
  manual.forEach(r => {
    const area = (r.AREA || "").toUpperCase(); const rnk = nameKey(r.COMPANY);
    const rdom = r.WEBSITE ? regDomain(r.WEBSITE.replace(/^https?:\/\//, "")) : "";
    const m = leads.find(l => (l.area || "").toUpperCase() === area && (
      (rdom && l.website && regDomain(l.website.replace(/^https?:\/\//, "")) === rdom) ||
      nameKey(l.name) === rnk || (nameKey(l.name).length >= 6 && rnk.startsWith(nameKey(l.name))) || (rnk.length >= 6 && nameKey(l.name).startsWith(rnk))));
    if (m) { m.source = m.source === "manual" ? "manual" : "both"; m.manual = true; m.verified = true; }
    else leads.push({ area, name: r.COMPANY, website: r.WEBSITE, source: "manual", manual: true, verified: true, enriched: false, pubCatId: guessCat(r.CATEGORY) });
  });
  return leads;
}
{
  // forgiving parse: mixed header case/aliases, area derived from district, required-field validation
  const raw = [
    { Company: "Rosewood Ceremonies", Category: "Funeral celebrant", Area: "CO", Website: "https://rosewoodceremonies.co.uk" }, // website
    { name: "Jane Field Celebrant", TYPE: "Celebrant", district: "CO7", Town: "Wivenhoe" },                                     // name+town only, area from district
    { COMPANY: "", CATEGORY: "Celebrant", AREA: "CO" },                                                                          // missing COMPANY → skip
    { COMPANY: "No Area Co", CATEGORY: "Celebrant" },                                                                            // missing AREA → skip
  ].map(normManualRow).filter(r => r.COMPANY && r.CATEGORY && r.AREA);
  eq(raw.length, 2, "required-field validation drops rows missing COMPANY/CATEGORY/AREA");
  eq(raw[1].AREA, "CO", "AREA derived from DISTRICT when omitted (CO7 → CO)");
  eq(guessCat(raw[0].CATEGORY), "celebrants", "CATEGORY 'Funeral celebrant' maps to marketplace 'celebrants'");

  const leads = [
    { area: "CO", name: "Rosewood Ceremonies", website: "https://www.rosewoodceremonies.co.uk" }, // already found by a sweep → both
    { area: "CO", name: "Colchester Funeral Co", website: "https://colchesterfunerals.co.uk" },   // discovery only
  ];
  const merged = foldInManual(leads, raw);
  const rose = merged.filter(l => /rosewood/i.test(l.name));
  eq(rose.length, 1, "manual firm already in the grid → exactly ONE row");
  eq(rose[0].source, "both", "…marked 'both'");
  eq(rose[0].verified, true, "…flagged verified (immune to classifier + chain exclusion)");
  const jane = merged.find(l => /jane field/i.test(l.name));
  eq(!!jane && jane.source, "manual", "manual firm discovery didn't find → still appears, source 'manual'");
  eq(jane.enriched, false, "…enriched:false so a website row would still be crawled");
  eq(jane.pubCatId, "celebrants", "…carries its own publish category");
  eq(merged.find(l => /colchester funeral/i.test(l.name)).source, "discovery", "discovery firm not in manual set → stays 'discovery'");
  // no area gate: a manual row for an area NOT in the grid is still added (unlike register)
  const leads2 = [{ area: "IG", name: "Ilford Funerals", source: "discovery" }];
  const m2 = foldInManual(leads2, [normManualRow({ COMPANY: "Barking Celebrant", CATEGORY: "Celebrant", AREA: "RM" })]);
  eq(!!m2.find(l => /barking/i.test(l.name) && l.area === "RM"), true, "manual row added even for an area the sweep never covered (no area gate)");
}

console.log("\n15. CONTACT_NAME gate: a director name is used ONLY on a HIGH-confidence Companies House match (name + postcode); an unverified (low/medium) match must leave CONTACT_NAME blank");
// mirror of the gate in enrichLead (index.html): website-scraped contact always allowed; a CH officer name
// is used ONLY when the match is HIGH confidence. Low/medium (fuzzy name-only) match → no contact.
function contactNameFor(chConfidence, officers, websiteContact) {
  let contact = websiteContact || "";
  if (!contact && chConfidence === "high" && officers && officers.length) contact = officers[0].split(",").reverse().join(" ").trim();
  return contact;
}
{
  // the exact failures Dan reported: fuzzy name-only CH matches leaking a director as the contact
  eq(contactNameFor("low", ["DUNKERTON, Julian Marc"], ""), "", "low-confidence CH match → CONTACT_NAME blank (no Superdry founder on a florist)");
  eq(contactNameFor("medium", ["QURESHI, Mohammed Qadeer Shabir"], ""), "", "medium-confidence CH match → CONTACT_NAME blank");
  eq(contactNameFor("high", ["BYRNES, Wade"], ""), "Wade BYRNES", "high-confidence CH match → director name IS the contact");
  eq(contactNameFor("low", ["DUNKERTON, Julian"], "Jane (owner, from website)"), "Jane (owner, from website)", "a website-scraped contact is kept even when the CH match is unverified");
  // end-to-end via chMatchConfidence: a name-only match (business postcode not corroborated) is medium → blank
  const nameOnly = chMatchConfidence("Lamberts Flower Company", "LAMBERT & CO LIMITED", "CV1 2AB", "Registered office: 10 Some Road, London, NW1 5AB");
  eq(nameOnly !== "high", true, "name matches but postcode doesn't corroborate → not high");
  eq(contactNameFor(nameOnly, ["DUNKERTON, Julian Marc"], ""), "", "…so that fuzzy match populates NO contact name");
  // a real match: name close AND registered office in the same postcode → high → contact allowed
  const corroborated = chMatchConfidence("Lily Alley Florist", "LILY ALLEY LTD", "CO1 1AA", "Registered office: 3 High St, Colchester, CO1 1AA");
  eq(corroborated, "high", "name close AND postcode corroborated → high");
  eq(contactNameFor(corroborated, ["MASON, Lily"], "") !== "", true, "…so a verified match may carry the contact");
}

console.log(`\n═══ ${PASS} passed, ${FAIL} failed ═══`);
process.exit(FAIL ? 1 : 0);
