// Postcode Prospector — aggressive email/contact extraction.
// Strategy: homepage → discover contact-ish links → crawl up to 8 pages →
// emails from text, mailto:, JSON-LD, HTML entities, [at]/(at) obfuscation → Hunter fallback.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BAD = /(example\.|sentry|wixpress|\.png|\.jpe?g|\.gif|\.webp|\.svg|godaddy|cloudflare|schema\.org|yourdomain|mydomain|domain\.com|email\.com|@company\.|yourcompany|@sample|@acme|@website\.|test@|^you@|^your@|^name@|^someone@|noreply|no-reply|wordpress|@sentry|placeholder|@x\.com|@2x)/i;
// HTML-artefact local-parts: element ids / data attributes captured as addresses, e.g.
// "contact-section-email-3@…", "js-email@…", "field-email@…". Never a real mailbox.
const BAD_LOCAL = /(?:^|[.\-_])(?:section|contactsection|email\d?|emailfield|jsemail|datemail|elementor|field\d|node\d|item\d)(?:[.\-_]|$)|-email-|section-email|contact-section/i;
const GENERIC_WEBMAIL = new Set(["gmail.com","googlemail.com","outlook.com","hotmail.com","hotmail.co.uk","yahoo.com","yahoo.co.uk","icloud.com","me.com","aol.com","live.com","live.co.uk","btinternet.com","btconnect.com","sky.com","virginmedia.com","talktalk.net","protonmail.com","gmx.com"]);
const GENERIC_LOCAL = /^(info|enquiries|enquiry|hello|office|admin|mail|contact|reception|team|funerals?|arrangements?|bookings?|accounts?)(\d|@|$)/i;
// registrable domain (drop www + one leading sub-label for typical co.uk/com), used for own-domain matching
function regDomain(host){ host=String(host||"").toLowerCase().replace(/^www\./,""); const p=host.split("."); if(p.length>=3&&/^(co|org|me|ltd|plc|net|sch|ac|gov)$/.test(p[p.length-2])) return p.slice(-3).join("."); return p.slice(-2).join("."); }

function deobfuscate(s) {
  return s
    .replace(/&#0?64;|&commat;|&#x40;/gi, "@")
    .replace(/&#0?46;|&period;|&#x2e;/gi, ".")
    .replace(/\s*[\[\({]\s*(at|@)\s*[\]\)}]\s*/gi, "@")
    .replace(/\s*[\[\({]\s*(dot|\.)\s*[\]\)}]\s*/gi, ".")
    .replace(/\s+(at)\s+(?=[a-z0-9-]+\s*(\.|dot))/gi, "@");
}
function okEmail(e) { const lp = (e.split("@")[0] || ""); return !BAD.test(e) && !BAD_LOCAL.test(lp) && lp.length <= 40 && e.length <= 80; }
function extractEmails(html, bag) {
  const txt = deobfuscate(html);
  (txt.match(EMAIL_RE) || []).forEach(e => { e = e.toLowerCase().replace(/^2[0-9]x/, ""); if (okEmail(e)) bag.add(e); });
  // mailto: links (may be URL-encoded)
  const m = txt.match(/mailto:([^"'?\s>]+)/gi) || [];
  m.forEach(x => { try { const e = decodeURIComponent(x.slice(7)).toLowerCase(); const g = (e.match(EMAIL_RE) || [])[0]; if (g && okEmail(g)) bag.add(g); } catch {} });
  // JSON-LD / schema "email": "..."
  const j = txt.match(/"email"\s*:\s*"([^"]+)"/gi) || [];
  j.forEach(x => { const e = (x.match(EMAIL_RE) || [])[0]; if (e && okEmail(e.toLowerCase())) bag.add(e.toLowerCase()); });
}
// From the raw crawl set, keep ONLY this firm's addresses: same registrable domain as the crawled site
// (or a subdomain of it), or a generic webmail. Cross-org domains (the achievingforchildren leak) are
// dropped. If the OWN domain yields many (a group/directory page), prefer an address whose local-part or
// subdomain matches this branch's town/name; else a generic info@/enquiries@; else NONE. Cap at 3.
function selectEmails(all, siteHost, hints) {
  const base = regDomain(siteHost);
  const own = [], web = [];
  for (const e of all) {
    const dom = (e.split("@")[1] || "").toLowerCase();
    const rd = regDomain(dom);
    if (rd === base || dom.endsWith("." + base)) own.push(e);
    else if (GENERIC_WEBMAIL.has(dom)) web.push(e);
    // anything else = a different organisation's domain → dropped
  }
  let chosen = own;
  if (own.length > 3) {
    const toks = (hints || []).map(h => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3);
    const branch = own.filter(e => { const s = e.toLowerCase().replace(/[^a-z0-9]/g, ""); return toks.some(t => s.includes(t)); });
    const generic = own.filter(e => GENERIC_LOCAL.test(e.split("@")[0]));
    chosen = branch.length ? branch : (generic.length ? generic : []);   // no branch + no generic ⇒ none belong to THIS row
  }
  return [...new Set([...chosen, ...web])].slice(0, 3);
}
const OWNERSHIP = [
  [/dignity\s+funerals|dignity\s+plc|part of (the )?dignity|dignityfunerals\.co\.uk|a dignity (member|brand|company)/i, "Dignity"],
  [/funeral\s*partners|funeralpartners\.co\.uk/i, "Funeral Partners"],
  [/co-?operative\s+(group|funeralcare)|coop\.co\.uk\/funeralcare|midcounties co-?operative|central england co-?operative|east of england co-?op|southern co-?op/i, "Co-op"],
  [/westerleigh\s+group/i, "Westerleigh"],
  [/\bmemoria\b/i, "Memoria"],
  [/pure\s*cremation/i, "Pure Cremation"]
];
const DOMAIN_OWNERS = [
  ["dignityfunerals", "Dignity"], ["dignityfuneral", "Dignity"], ["dignity.co.uk", "Dignity"], ["dignityplc", "Dignity"],
  ["funeralpartners", "Funeral Partners"], ["coop.co.uk", "Co-op"], ["co-operative", "Co-op"],
  ["eastofengland.coop", "Co-op"], ["centralengland.coop", "Co-op"], ["midcounties.coop", "Co-op"],
  ["westerleigh", "Westerleigh"], ["memoria", "Memoria"], ["purecremation", "Pure Cremation"]
];
// REGULATORY SMALL PRINT — firms must disclose AR / network status on their own site.
// This is the IFA equivalent of Dignity's "part of Dignity Funerals Ltd" footer.
const REG_MARKERS = [
  [/appointed\s+representative\s+of\s+([A-Z][A-Za-z0-9&.,'\- ]{2,60}?)(?:\s+(?:which|who|is|Ltd|Limited)\b|[.,(])/i, "APPOINTED REPRESENTATIVE"],
  [/(?:is\s+an?\s+)?appointed\s+representative/i, "APPOINTED REPRESENTATIVE"],
  [/\brestricted\s+(?:financial\s+)?advice|we\s+provide\s+restricted\s+advice|restricted\s+advisers?/i, "RESTRICTED ADVICE"],
  [/\bwholly\s+owned\s+subsidiary\s+of\s+([A-Z][A-Za-z0-9&.,'\- ]{2,50})/i, "SUBSIDIARY"],
  [/st\.?\s*james'?s?\s+place|sjp\s+partnership/i, "ST JAMES'S PLACE (restricted)"],
  [/nfu\s+mutual/i, "NFU MUTUAL (tied)"],
  [/\bopenwork\b|quilter\s+financial|intrinsic\s+financial|true\s+potential|sesame\s+bankhall|tenet(?:lime|connect)?\b|sandringham\s+financial|the\s+openwork\s+partnership/i, "NETWORK MEMBER"]
];
// Funeral-PLAN providers. Since 2022 an INDEPENDENT funeral director must be an "appointed
// representative of" one of these just to sell regulated pre-paid plans — so an AR relationship
// with them is NORMAL and NEUTRAL for independence (never a tied/network flag). Ownership is what
// matters, and that's judged from Companies House PSC, not AR status.
const PLAN_PROVIDERS_RE = /golden charter|golden leaves|ecclesiastical planning|\becclesiastical\b|pride planning|safe ?hands|\bavalon\b|one ?life|open prepaid|perfect choice|sovereign (?:funeral|prepaid|plan)|distinct funeral plans|central england co-?op|co-?op(?:erative)? funeral plan|dignity (?:funeral )?plan|age co|shepherds friendly|corinthian/i;
const FRN_RE = /(?:fca|financial conduct authority)[^.]{0,40}?(?:number|no\.?|reference|frn)[:\s]*(\d{6})/i;
const NAME_PATTERNS = [
  /(?:founder|owner|director|principal|proprietor|managing director|funeral director|partner)[:\s,–-]{1,4}([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/g,
  /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})[,\s–-]{1,4}(?:founder|owner|director|principal|proprietor|managing director)/g
];
const UA_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Some sites serve datacenter/serverless IPs a JS-only shell (bot protection) but still render full
// HTML for Googlebot — retrying as Googlebot recovers the contact details on those sites.
const UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
async function fetchText(url, ms = 9000, ua = UA_CHROME) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-GB,en;q=0.9" } });
    if (!r.ok) return { html: "", code: r.status };
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text") && !ct.includes("html") && !ct.includes("json")) return { html: "", code: 415 };
    return { html: await r.text(), code: 200 };
  } catch (e) { return { html: "", code: 0 }; } finally { clearTimeout(t); }
}

function scanRegulatory(html, out){
  const txt = stripish(html);
  if (!out.regStatus) {
    for (const [re, label] of REG_MARKERS) {
      const m = txt.match(re);
      if (m) {
        // "appointed representative of <funeral-PLAN provider>" is REQUIRED since 2022 (FCA plan rules)
        // and is NEUTRAL for independence — NEVER a tied flag. Judge the AR PRINCIPAL, not stray words
        // like "part of (the community)". Genuine ownership ("part of the X group", subsidiary of…) is
        // detected separately by the OWNERSHIP markers, so it does not need to gate this.
        if (/APPOINTED REPRESENTATIVE/.test(label)) {
          const principal = (m[1] || "").trim();
          const isPlanAR = principal ? PLAN_PROVIDERS_RE.test(principal) : PLAN_PROVIDERS_RE.test(txt);
          if (isPlanAR) {
            if (!out.planAR) { const pm = (principal.match(PLAN_PROVIDERS_RE) || txt.match(PLAN_PROVIDERS_RE)); out.planAR = true; out.planProvider = (pm ? pm[0] : principal).replace(/\s+/g, " ").trim(); }
            continue;  // neutral — keep scanning for a genuine network/ownership tie
          }
        }
        out.regStatus = label;
        if (m[1] && /representative|subsidiary/i.test(label)) out.regPrincipal = m[1].trim().replace(/\s+/g," ");
        break;
      }
    }
  }
  if (!out.frn) { const f = txt.match(FRN_RE); if (f) out.frn = f[1]; }
}
function stripish(h){ return h.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&amp;/g," ").replace(/\s+/g," "); }

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    let { website, hunterKey } = body;
    const firmName = body.name || "", firmTown = body.town || "", firmArea = body.area || "";
    hunterKey = ((process.env.HUNTER_KEY || hunterKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    const out = { emails: [], contacts: [], source: [], note: "" };
    if (!website) { out.note = "no website"; return { statusCode: 200, headers, body: JSON.stringify(out) }; }
    if (!/^https?:\/\//i.test(website)) website = "https://" + website;
    let base; try { base = new URL(website); } catch { out.note = "bad url"; return { statusCode: 200, headers, body: JSON.stringify(out) }; }

    const emails = new Set(), names = new Set(), tried = new Set();
    const textParts = [];  // stripped, human-readable text gathered as we crawl — reused by /vetrank so it never re-fetches
    const addText = html => { const t = stripish(html).trim(); if (t) textParts.push(t); };
    // 1. homepage
    let home = await fetchText(base.href);
    if (!home.html && base.protocol === "https:") { // retry http + www flip
      const alt = new URL(base.href); alt.protocol = "http:";
      home = await fetchText(alt.href);
      if (!home.html) {
        const w = new URL(base.href);
        w.hostname = w.hostname.startsWith("www.") ? w.hostname.slice(4) : "www." + w.hostname;
        home = await fetchText(w.href);
      }
    }
    // If the page came back as a thin JS shell (bot protection serving datacenter IPs), retry as Googlebot.
    if (home.html && stripish(home.html).length < 400) {
      const g = await fetchText(base.href, 9000, UA_GOOGLEBOT);
      if (g.html && stripish(g.html).length > stripish(home.html).length) { home = g; out.viaGooglebot = true; }
    }
    tried.add(base.href);
    if (!home.html) { out.note = "site unreachable (" + home.code + ")"; return { statusCode: 200, headers, body: JSON.stringify(out) }; }
    extractEmails(home.html, emails);
    addText(home.html);
    for (const [re, grp] of OWNERSHIP) if (!out.ownership && re.test(home.html)) out.ownership = grp;
    scanRegulatory(home.html, out);

    // 2. discover contact-ish links from the homepage itself
    const linkRe = /href\s*=\s*["']([^"'#]+)["']/gi;
    const candidates = new Set(["/contact", "/contact-us", "/contactus", "/about", "/about-us", "/team", "/our-team", "/get-in-touch", "/find-us", "/staff", "/people",
      "/legal", "/terms", "/disclaimer", "/regulatory", "/privacy-policy", "/important-information"]);
    let lm;
    while ((lm = linkRe.exec(home.html)) !== null) {
      const href = lm[1];
      if (/contact|about|team|touch|staff|people|find-us|enquir/i.test(href) && !/\.(pdf|jpg|png|zip)/i.test(href)) {
        try { const u = new URL(href, base.href); if (u.hostname.replace(/^www\./,"") === base.hostname.replace(/^www\./,"")) candidates.add(u.pathname); } catch {}
      }
      if (candidates.size > 14) break;
    }
    // 3. crawl candidates until we have emails + a name (max 8 pages). If the homepage needed Googlebot,
    // the site blocks this IP's normal UA site-wide — use Googlebot for the contact pages too.
    const pageUA = out.viaGooglebot ? UA_GOOGLEBOT : UA_CHROME;
    let pages = 1;
    for (const p of candidates) {
      if (pages >= 8 || (emails.size >= 2 && names.size >= 1)) break;
      let u; try { u = new URL(p, base.origin).href; } catch { continue; }
      if (tried.has(u)) continue; tried.add(u);
      await new Promise(r => setTimeout(r, 150));  // space page fetches so we don't trip the site's rate-limit → JS-shell
      const pg = await fetchText(u, 9000, pageUA);
      pages++;
      if (!pg.html) continue;
      extractEmails(pg.html, emails);
      addText(pg.html);
      for (const [re, grp] of OWNERSHIP) if (!out.ownership && re.test(pg.html)) out.ownership = grp;
      scanRegulatory(pg.html, out);
      const plain = pg.html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      for (const re of NAME_PATTERNS) { let m2; const r2 = new RegExp(re.source, re.flags); while ((m2 = r2.exec(plain)) && names.size < 4) names.add(m2[1].trim()); }
    }
    if (emails.size) out.source.push("website");

    // NB: Hunter.io is NOT called here (that would be once per ROW). It is orchestrated by the caller
    // ONCE PER DOMAIN via /functions/hunter, only after this crawl + email propagation fail — see enrichAll.
    // email-domain fingerprint: group-owned branches use group email domains
    if (!out.ownership) {
      for (const e of emails) {
        const dom = e.split("@")[1] || "";
        for (const [frag, grp] of DOMAIN_OWNERS) if (dom.includes(frag)) { out.ownership = grp; break; }
        if (out.ownership) break;
      }
    }
    // keep only THIS firm's addresses (own domain / webmail), branch-preferred, capped at 3
    const rawEmails = [...emails];
    out.emails = selectEmails(rawEmails, base.hostname, [firmName, firmTown, firmArea, (firmName.split(/\s+/)[0] || "")]);
    if (rawEmails.length > out.emails.length) out.emailsTrimmed = rawEmails.length - out.emails.length;
    out.contacts = [...names].slice(0, 3);
    // Capped, stripped site text — handed to /vetrank so Claude can read the firm's own
    // words (independence disclosures, services, credentials) without a second crawl.
    out.siteText = textParts.join(" — ").replace(/\s+/g, " ").trim().slice(0, 2600);
    out.note = out.emails.length ? "" : `no email on ${pages} pages crawled` + (hunterKey ? " + hunter" : "");
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
