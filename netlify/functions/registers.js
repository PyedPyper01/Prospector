// Postcode Prospector — UNIFIED REGISTER VERIFIER.
// One function, every Tier-1 authority. Routed by `register` param.
//   cqc     — Care Quality Commission (home care, domiciliary, live-in care). Free, no key needed.
//   fsa     — Food Standards Agency hygiene ratings (caterers, wake venues). Free, no key.
//   ea      — Environment Agency waste carrier register (house/estate clearance). Free, no key.
//   charity — Charity Commission (children's bereavement, pet rehoming). Needs CHARITY_KEY (free).
//   sra     — Solicitors Regulation Authority (probate/conveyancing). No public API — returns a verify URL.
// Every branch degrades gracefully: never throws, always returns a verdict.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
const norm = s => (s||"").toLowerCase().replace(/\b(ltd|limited|llp|plc|the|and|&|co|group)\b/g,"").replace(/[^a-z0-9]/g,"");
function sim(a,b){ a=norm(a); b=norm(b); if(!a||!b) return 0; if(a===b) return 1; if(a.includes(b)||b.includes(a)) return 0.85; return 0; }

async function getJSON(url, headers={}, ms=9000){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms);
  try{ const r=await fetch(url,{signal:c.signal,headers}); if(!r.ok) return null; return await r.json(); }
  catch{ return null; } finally{ clearTimeout(t); }
}

// ---------- CQC: registered care providers, with rating ----------
async function cqc(name, postcode, key){
  const h = key ? { "Ocp-Apim-Subscription-Key": key } : {};
  const q = encodeURIComponent(name);
  const d = await getJSON(`https://api.service.cqc.org.uk/public/v1/providers?providerName=${q}&perPage=20`, h);
  const items = (d && d.providers) || [];
  if(!items.length) return { found:false, verdict:"NOT CQC-REGISTERED" };
  let best=null, bs=0;
  for(const p of items){ const s=sim(name,p.providerName||""); if(s>bs){bs=s;best=p;} }
  if(!best||bs<0.5) return { found:false, verdict:"NOT CQC-REGISTERED" };
  const det = await getJSON(`https://api.service.cqc.org.uk/public/v1/providers/${best.providerId}`, h);
  const rating = det && det.currentRatings && det.currentRatings.overall ? det.currentRatings.overall.rating : "";
  const type = det ? (det.providerType||"") : "";
  const good = /outstanding|good/i.test(rating);
  return { found:true, id:best.providerId, rating, providerType:type,
    verdict: rating ? (good ? `CQC ${rating}` : `CQC ${rating} — below Good`) : "CQC-registered (no rating yet)",
    keep: !rating || good };
}
// ---------- FSA: food hygiene rating ----------
async function fsa(name, postcode){
  const q = encodeURIComponent(name);
  const d = await getJSON(`https://api.ratings.food.gov.uk/Establishments?name=${q}&address=${encodeURIComponent(postcode||"")}&pageSize=10`,
    { "x-api-version": "2", "Accept": "application/json" });
  const items = (d && d.establishments) || [];
  if(!items.length) return { found:false, verdict:"NOT ON FSA REGISTER" };
  let best=null, bs=0;
  for(const e of items){ const s=sim(name,e.BusinessName||""); if(s>bs){bs=s;best=e;} }
  if(!best||bs<0.5) return { found:false, verdict:"NOT ON FSA REGISTER" };
  const r = parseInt(best.RatingValue,10);
  const ok = !isNaN(r) && r>=4;
  return { found:true, rating:best.RatingValue, verdict: isNaN(r)?`FSA: ${best.RatingValue}`:`FSA hygiene ${r}/5`, keep: ok };
}
// ---------- EA: waste carrier registration (legally required for house clearance) ----------
async function ea(name){
  const q = encodeURIComponent(name);
  const d = await getJSON(`https://environment.data.gov.uk/public-register/waste-carriers-brokers/registration.json?name=${q}&_limit=10`);
  const items = (d && d.items) || [];
  if(!items.length) return { found:false, verdict:"NO WASTE CARRIER LICENCE", keep:false };
  let best=null, bs=0;
  for(const i of items){ const nm=i.registeredName || i.tradingName || (i.operator&&i.operator.name) || ""; const s=sim(name,nm); if(s>bs){bs=s;best=i;} }
  if(!best||bs<0.5) return { found:false, verdict:"NO WASTE CARRIER LICENCE", keep:false };
  const tier = best.tier || best.registrationTier || "";
  const num = best.registrationNumber || best.reference || "";
  return { found:true, licence:num, verdict:`WASTE CARRIER ✓ ${tier?("("+tier+")"):""} ${num}`.trim(), keep:true };
}
// ---------- Charity Commission ----------
async function charity(name, key){
  if(!key) return { skipped:true, verdict:"(no Charity Commission key)" };
  const d = await getJSON(`https://api.charitycommission.gov.uk/register/api/searchCharityName/${encodeURIComponent(name)}`,
    { "Ocp-Apim-Subscription-Key": key });
  const items = Array.isArray(d) ? d : [];
  if(!items.length) return { found:false, verdict:"NOT A REGISTERED CHARITY" };
  let best=null, bs=0;
  for(const c of items){ const s=sim(name,c.charity_name||""); if(s>bs){bs=s;best=c;} }
  if(!best||bs<0.5) return { found:false, verdict:"NOT A REGISTERED CHARITY" };
  return { found:true, charityNumber:best.reg_charity_number, verdict:`REGISTERED CHARITY ${best.reg_charity_number}`, keep:true };
}
// ---------- SRA (no public API — supply the verify link) ----------
function sra(name){
  return { found:null, verdict:"VERIFY ON SRA", url:`https://solicitors.lawsociety.org.uk/search/results?Pro=False&Name=${encodeURIComponent(name)}`, keep:true };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const b = JSON.parse(event.body || "{}");
    const reg = (b.register || "").toLowerCase();
    const name = (b.name || "").trim();
    if (!name) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };
    let out;
    switch (reg) {
      case "cqc":     out = await cqc(name, b.postcode, clean(process.env.CQC_KEY || b.cqcKey)); break;
      case "fsa":     out = await fsa(name, b.postcode); break;
      case "ea":      out = await ea(name); break;
      case "charity": out = await charity(name, clean(process.env.CHARITY_KEY || b.charityKey)); break;
      case "sra":     out = sra(name); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown register: " + reg }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ register: reg, ...out }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, verdict: "check failed" }) };
  }
};
