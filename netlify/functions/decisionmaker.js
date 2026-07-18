// Postcode Prospector — DECISION-MAKER WATERFALL.
// Finds the owner/principal of a local business by stacking free-first sources:
//   1. Companies House done properly: location-scored match → active directors (authoritative for Ltds)
//   2. Targeted about/team-page crawl → Claude extraction (best for sole traders & partnerships)
//   3. Optional Google Programmable Search (CSE) → local press/awards snippets → Claude extraction
//   4. Merge, rank, dedupe → email-pattern suggestions (marked unverified) + one-click manual search URLs
// Same conventions as the other functions: env var OR key passed in body; every stage skips gracefully.
// Env vars: CH_API_KEY, ANTHROPIC_API_KEY, (optional) GOOGLE_CSE_KEY + GOOGLE_CSE_ID.

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-GB,en;q=0.9" };
const ABOUT_RE = /about|team|our-story|ourstory|meet|people|staff|who-we-are|whoweare|history|founder/i;

function clean(k){ return ((k||"").replace(/[^\x21-\x7E]/g,"").trim())||null; }
function stripTags(html){ return html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&amp;|&#\d+;/g," ").replace(/\s+/g," ").trim(); }
function chName(n){ // "SMITH, John Andrew" -> "John Andrew Smith"
  if(!n) return ""; const p=n.split(","); if(p.length<2) return n.trim();
  return (p.slice(1).join(",").trim()+" "+p[0].trim()).replace(/\b([A-Z])([A-Z]+)\b/g,(m,a,b)=>a+b.toLowerCase());
}
function postcodeOf(addr){ const m=(addr||"").toUpperCase().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/); return m?m[1]:null; }
function sim(a,b){ a=(a||"").toLowerCase().replace(/\b(ltd|limited|llp|the|and|&|co|company|funeral|directors?|services?)\b/g,"").replace(/[^a-z0-9]/g,""); b=(b||"").toLowerCase().replace(/\b(ltd|limited|llp|the|and|&|co|company|funeral|directors?|services?)\b/g,"").replace(/[^a-z0-9]/g,""); if(!a||!b) return 0; if(a===b) return 1; if(a.includes(b)||b.includes(a)) return .8; let n=0; for(const w of new Set(a.match(/.{3}/g)||[])) if(b.includes(w)) n++; return Math.min(.7, n/12); }

async function fetchText(url, ms=9000){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),ms);
  try{ const r=await fetch(url,{signal:ctrl.signal,redirect:"follow",headers:UA}); if(!r.ok) return ""; return await r.text(); }
  catch(e){ return ""; } finally{ clearTimeout(t); }
}

async function claudeJSON(apiKey, system, user, maxTokens=350){
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
    body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:maxTokens,system,messages:[{role:"user",content:user}]})});
  const d=await r.json(); if(d.error) return null;
  const text=(d.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n").replace(/```json|```/g,"").trim();
  try{ return JSON.parse(text); }catch(e){ return null; }
}

// ---------- STAGE 1: Companies House with location scoring ----------
async function stageCH(name, address, chKey){
  if(!chKey) return { skipped:true };
  const auth="Basic "+Buffer.from(chKey+":").toString("base64");
  const pc=postcodeOf(address);
  const q=(name||"").replace(/\s*[-–|].*$/,"").trim(); if(!q) return { skipped:true };
  const sr=await fetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}&items_per_page=10`,{headers:{Authorization:auth}});
  if(!sr.ok) return { skipped:true };
  const sd=await sr.json();
  // score: name similarity + postcode-district match beats name-only matching every time
  let best=null,bestScore=0;
  for(const it of (sd.items||[])){
    let s=sim(q,it.title||"");
    const ipc=postcodeOf(it.address_snippet||"");
    if(pc&&ipc){ if(ipc===pc) s+=.5; else if(ipc.slice(0,2)===pc.slice(0,2)) s+=.2; }
    if(it.company_status==="active") s+=.15;
    if(s>bestScore){ bestScore=s; best=it; }
  }
  if(!best||bestScore<0.55) return { found:false, note:"No confident CH match (trading name may differ from registered name — normal for sole traders)" };
  const num=best.company_number;
  const or_=await fetch(`https://api.company-information.service.gov.uk/company/${num}/officers?items_per_page=10`,{headers:{Authorization:auth}});
  const out={ found:true, companyNumber:num, companyName:best.title, matchScore:Math.round(bestScore*100)/100, candidates:[] };
  if(or_.ok){
    const od=await or_.json();
    out.candidates=(od.items||[]).filter(o=>!o.resigned_on&&/director/i.test(o.officer_role||""))
      .map(o=>({ name:chName(o.name), role:o.officer_role.replace(/-/g," "), source:"Companies House", evidence:`Active ${o.officer_role} of ${best.title} (${num})${o.appointed_on?", appointed "+o.appointed_on:""}`, confidence:0.9 })).slice(0,4);
  }
  return out;
}

// ---------- STAGE 2: targeted about-page crawl + Claude extraction ----------
async function stageSite(website, anthropicKey){
  if(!website) return { skipped:true, reason:"no website" };
  let base; try{ base=new URL(website.startsWith("http")?website:"https://"+website); }catch(e){ return { skipped:true }; }
  const home=await fetchText(base.href); if(!home) return { skipped:true, reason:"site unreachable" };
  // gather about-ish links + always try common paths
  const links=new Set(["/about","/about-us","/team","/our-story","/meet-the-team","/who-we-are"]);
  (home.match(/href=["']([^"'#]+)["']/gi)||[]).forEach(h=>{ const u=h.slice(6,-1); if(ABOUT_RE.test(u)&&!/\.(pdf|jpg|png|css|js)/i.test(u)) links.add(u); });
  let text=stripTags(home).slice(0,3000);
  let fetched=0;
  for(const l of links){ if(fetched>=4) break;
    try{ const u=new URL(l,base.href); if(u.hostname!==base.hostname) continue;
      const h=await fetchText(u.href,7000); if(h){ text+="\n\n[PAGE "+u.pathname+"]\n"+stripTags(h).slice(0,3500); fetched++; } }catch(e){}
  }
  // JSON-LD founder/person is gold when present
  const ld=(home.match(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)||[]).join(" ");
  if(ld) text+="\n\n[STRUCTURED DATA]\n"+ld.replace(/<[^>]+>/g,"").slice(0,2000);
  if(!anthropicKey) return { skipped:true, reason:"no ANTHROPIC_API_KEY — site text gathered but not analysed", pages:fetched };
  const parsed=await claudeJSON(anthropicKey,
`You extract the decision maker of a small UK business from its own website text. Respond with ONLY JSON, no fences:
{"candidates":[{"name":string,"role":string,"evidence":string (short quote or close paraphrase of where this appears),"confidence":number 0-1}], "note":string}
Rules: only people the SITE ITSELF presents as owner, founder, principal, proprietor, partner, managing/funeral director OF THIS BUSINESS. Family-firm phrasing counts ("run by the Smith family since 1962" -> note it; "fourth-generation, led by ..."). NEVER include: customers or reviewers, staff without seniority, people from testimonials, or names you are unsure belong to this firm. If none, return {"candidates":[],"note":"none found on site"}. Max 3 candidates.`,
    `Business: ${base.hostname}\n\nSITE TEXT:\n${text.slice(0,11000)}`);
  if(!parsed) return { skipped:true, reason:"extraction failed", pages:fetched };
  (parsed.candidates||[]).forEach(c=>{ c.source="Business website"; c.confidence=Math.min(c.confidence||0.6,0.85); });
  return { found:(parsed.candidates||[]).length>0, candidates:parsed.candidates||[], note:parsed.note, pages:fetched };
}

// ---------- STAGE 3: optional public-web search (Google Programmable Search) ----------
async function stageCSE(name, town, cseKey, cseId, anthropicKey){
  if(!cseKey||!cseId) return { skipped:true, reason:"no CSE keys (optional)" };
  const q=`"${name}" ${town||""} (owner OR founder OR director OR proprietor)`;
  const r=await fetch(`https://www.googleapis.com/customsearch/v1?key=${cseKey}&cx=${cseId}&q=${encodeURIComponent(q)}&num=6&gl=uk`);
  if(!r.ok) return { skipped:true, reason:"CSE error "+r.status };
  const d=await r.json();
  const snippets=(d.items||[]).map(i=>`[${i.link}] ${i.title} — ${i.snippet}`).join("\n").slice(0,6000);
  if(!snippets) return { found:false };
  if(!anthropicKey) return { skipped:true, reason:"snippets gathered, no ANTHROPIC_API_KEY to analyse" };
  const parsed=await claudeJSON(anthropicKey,
`You extract the decision maker of a specific UK business from web search snippets (local press, awards, trade directories). Respond ONLY JSON:
{"candidates":[{"name":string,"role":string,"evidence":string (which snippet/URL says so),"confidence":number 0-1}]}
Rules: the person must be explicitly tied to THIS business by the snippet. Prefer local-press phrasing ("director Jane Smith of X"). Never guess from partial matches to similarly named firms elsewhere. Max 2. Empty array if unsure.`,
    `Business: "${name}" in ${town||"the UK"}\n\nSNIPPETS:\n${snippets}`);
  if(!parsed) return { found:false };
  (parsed.candidates||[]).forEach(c=>{ c.source="Public web (press/directories)"; c.confidence=Math.min(c.confidence||0.5,0.75); });
  return { found:(parsed.candidates||[]).length>0, candidates:parsed.candidates||[] };
}

// ---------- Email pattern suggestions (explicitly unverified) ----------
function emailPatterns(fullName, website, knownEmails){
  try{
    const dom=new URL(website.startsWith("http")?website:"https://"+website).hostname.replace(/^www\./,"");
    const p=fullName.toLowerCase().replace(/[^a-z\s]/g,"").split(/\s+/).filter(Boolean);
    if(p.length<2) return [];
    const [f,l]=[p[0],p[p.length-1]];
    const guesses=[`${f}@${dom}`,`${f}.${l}@${dom}`,`${f[0]}${l}@${dom}`,`${f}${l[0]}@${dom}`];
    // if a real address exists, mirror its pattern for the person
    const seen=(knownEmails||[]).find(e=>e.endsWith("@"+dom)&&!/^(info|office|enquiries|hello|contact|admin|sales)@/.test(e));
    if(seen) guesses.unshift(seen.replace(/^[^@]+/, m=> m.includes(".")?`${f}.${l}`:f));
    return [...new Set(guesses)].slice(0,4);
  }catch(e){ return []; }
}

exports.handler = async (event) => {
  const headers={ "Access-Control-Allow-Origin":"*", "Content-Type":"application/json" };
  if(event.httpMethod==="OPTIONS") return { statusCode:204, headers:{...headers,"Access-Control-Allow-Headers":"*"} };
  try{
    const body=JSON.parse(event.body||"{}");
    if(body.ping) return { statusCode:200, headers, body:JSON.stringify({pong:true}) };
    const name=(body.name||"").trim();
    if(!name) return { statusCode:400, headers, body:JSON.stringify({error:"Missing business name"}) };
    const address=body.address||"", website=body.website||"", town=(address.split(",").slice(-3,-2)[0]||"").trim();
    const chKey=clean(process.env.CH_API_KEY||body.chKey);
    const antKey=clean(process.env.ANTHROPIC_API_KEY||body.anthropicKey);
    const cseKey=clean(process.env.GOOGLE_CSE_KEY||body.cseKey);
    const cseId=clean(process.env.GOOGLE_CSE_ID||body.cseId);

    const [ch, site, cse]=await Promise.all([
      stageCH(name,address,chKey).catch(e=>({skipped:true,error:e.message})),
      stageSite(website,antKey).catch(e=>({skipped:true,error:e.message})),
      stageCSE(name,town,cseKey,cseId,antKey).catch(e=>({skipped:true,error:e.message}))
    ]);

    // merge + dedupe by normalised name, keep highest-confidence instance, sum corroboration
    const all=[...(ch.candidates||[]),...(site.candidates||[]),...(cse.candidates||[])];
    const byName={};
    for(const c of all){
      const k=(c.name||"").toLowerCase().replace(/[^a-z]/g,"");
      if(!k) continue;
      if(!byName[k]) byName[k]={...c, sources:[c.source]};
      else{ byName[k].confidence=Math.min(0.98, Math.max(byName[k].confidence,c.confidence)+0.15); byName[k].sources.push(c.source); byName[k].evidence+=" | "+c.evidence; }
    }
    const ranked=Object.values(byName).sort((a,b)=>b.confidence-a.confidence).slice(0,3);
    const top=ranked[0]||null;

    return { statusCode:200, headers, body:JSON.stringify({
      decisionMaker: top ? top.name : null,
      role: top ? top.role : null,
      confidence: top ? top.confidence : 0,
      corroborated: top ? top.sources.length>1 : false,
      candidates: ranked,
      emailGuesses: top&&website ? emailPatterns(top.name, website, body.knownEmails||[]) : [],
      emailGuessNote: "Pattern suggestions only — UNVERIFIED. Verify before sending (or route through the existing Hunter fallback).",
      companiesHouse: { found:!!ch.found, companyNumber:ch.companyNumber||null, matchScore:ch.matchScore||null, note:ch.note||null },
      siteCrawl: { pagesRead:site.pages||0, note:site.note||site.reason||null },
      webSearch: { used:!(cse.skipped), note:cse.reason||null },
      manualAssist: {
        linkedin: `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in "'+name+'" '+(town||''))}`,
        press: `https://www.google.com/search?q=${encodeURIComponent('"'+name+'" '+(town||'')+' owner OR founder OR director')}`,
        fcaRegister: `https://register.fca.org.uk/s/search?q=${encodeURIComponent(name)}&type=Companies`
      },
      note: "Waterfall: Companies House (location-scored) + site crawl with AI extraction" + (cse.skipped?"":" + public-web search") + ". manualAssist links are for one-click human lookup — LinkedIn is never scraped automatically."
    })};
  }catch(e){
    return { statusCode:500, headers, body:JSON.stringify({error:e.message}) };
  }
};
