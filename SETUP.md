# Postcode Prospector — Setup

District-tiled lead-sourcing tool for UK independent suppliers. A single static `index.html` plus a set
of Netlify Functions. No build step, no framework, no `package.json` dependencies — the functions use only
Node's built-in `fetch`/`Buffer`.

## Clone

```bash
git clone https://github.com/PyedPyper01/Prospector.git
cd Prospector
```

## Install

Nothing to install for the app itself. To deploy or run locally you need the Netlify CLI:

```bash
npm install -g netlify-cli
```

## Keys — which goes where

Every function reads its key from an **environment variable first**, then falls back to a value pasted into
the app's ⚙ **Settings** panel (stored in the browser's `localStorage` only). **No key is ever committed.**

Set these as environment variables on the Netlify site (Site configuration → Environment variables), scoped
to **Functions**:

| Env var | Used by | Where to get it |
|---|---|---|
| `GOOGLE_PLACES_KEY` | `search.js` (Google Places discovery) | console.cloud.google.com → enable *Places API (New)* |
| `ANTHROPIC_API_KEY` | `interpret`, `classify`, `vetrank`, `sourcerouter`, `describe` | console.anthropic.com |
| `CH_API_KEY` | `companieshouse.js` (ownership / directors) | developer.company-information.service.gov.uk (free) |
| `FCA_API_KEY` + `FCA_EMAIL` | `fca.js` (IFA permission checks) | register.fca.org.uk developer portal |
| `FIRECRAWL_API_KEY` | `firecrawl.js` (deep JS-rendered email crawl) | firecrawl.dev |
| `HUNTER_KEY` | `hunter.js` (email fallback) | hunter.io |
| `CQC_KEY` | `freesearch.js` / CQC source (care category) | api-portal.service.cqc.org.uk (free) |
| `SUPPLIER_IMPORT_TOKEN` | `publish.js` (push approved leads to AfterLife) | the AfterLife site's env |

Free data sources (OpenStreetMap/Overpass, FSA, EA, postcodes.io) need **no key**.

## Run / deploy

- **Deploy to production:** `netlify deploy --prod` (or push to `main` once the repo is linked to the site —
  see below).
- **Local preview of functions:** `netlify dev` (requires the env vars locally; not needed for normal use).

## Connect the repo to Netlify (deploy-on-push)

In the Netlify UI: **Site configuration → Build & deploy → Continuous deployment → Link repository →
GitHub → PyedPyper01/Prospector**. Publish directory `.`, functions directory `netlify/functions`, no build
command. After that, every push to `main` deploys automatically with full deploy history and one-click
rollback.

## Register-supply import (Email Lead Generator)

The Email Lead Generator writes `out/register_supply.csv` (register-verified independent counterparties).
In the app, **4¾ · Register supply → Load register_supply.csv**. It merges into every sweep of a matching
area+category; each result row is tagged `register` / `discovery` / `both`, SAIF membership is carried
through to export, and confirmed consolidators are excluded. (Data files live in `out/` and are gitignored.)

## Tests

```bash
node test/fixtures.js
```

A no-API-call regression suite covering chain exclusion, group-vs-brand-vs-registry logic, email extraction,
Companies-House match confidence, parent-name labelling, and the register merge. Run it before every deploy.
