POSTCODE PROSPECTOR — deployment (2 minutes)

1. Go to app.netlify.com → "Add new site" → "Deploy manually" → drag this whole
   folder (or the zip's extracted contents) onto the page. Done — site is live.

2. Keys (Site settings → Environment variables → Add):
   GOOGLE_PLACES_KEY  — console.cloud.google.com → enable "Places API (New)" → create API key
   CH_API_KEY         — developer.company-information.service.gov.uk → free account → create key
   HUNTER_KEY         — hunter.io (optional, email fallback)
   Then redeploy (Deploys → Trigger deploy). Alternatively paste keys into the
   app's Settings panel — they stay in your browser only.

3. Use: enter area (CO / B / SE…) → districts auto-fill (editable) → pick a
   category preset or type a custom term → set rules (omit chains, min reviews,
   funnel cap) → Run district sweep → Enrich → Export CSV/XLSX.

Costs: Google bills per search (~£25–30 per 1,000). One area × one category is
typically 15–45 searches. Companies House is free. Enrichment website crawls are free.
