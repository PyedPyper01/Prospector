#!/usr/bin/env python3
"""
Deploy Postcode Prospector to Netlify — index.html plus all functions.

Written in Python on purpose: the machine has no system Node, and the portable Node kept in /private/tmp
gets pruned by macOS, which stranded the old deploy scripts. Python 3 ships with macOS, and this file lives
in the project rather than a temp folder, so it survives.

Usage:
    python3 deploy.py            # index.html + every function
    python3 deploy.py --html     # index.html only (fast; use when no function changed)

Netlify requires EVERY function zip whenever its bundle cache has expired, which is why the default
re-uploads them all — a partial deploy just hangs in "uploading" forever.
"""
import hashlib, json, os, ssl, sys, time, urllib.request, zipfile, io

SITE = "5483054b-c541-43e3-9fca-ee9fa360b39c"           # postcodeprospector
PROJ = os.path.dirname(os.path.abspath(__file__))
API = "https://api.netlify.com/api/v1"
CTX = ssl.create_default_context()


def token():
    p = os.path.expanduser("~/Library/Preferences/netlify/config.json")
    d = json.load(open(p))
    for u in (d.get("users") or {}).values():
        t = (u.get("auth") or {}).get("token")
        if t:
            return t
    sys.exit("No Netlify token found — run `netlify login` first.")


TOK = token()


def req(method, path, data=None, ctype="application/json", raw=False):
    url = path if path.startswith("http") else API + path
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header("Authorization", "Bearer " + TOK)
    if body is not None:
        r.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=180) as resp:
            txt = resp.read()
            return resp.status, (json.loads(txt) if txt and not raw else txt)
    except urllib.error.HTTPError as e:
        # Netlify explains a rejection in the BODY. Letting the HTTPError propagate threw a stack trace that
        # named urllib and not the file it choked on, which is useless for fixing it.
        body = ""
        try: body = e.read().decode("utf-8", "ignore")[:300]
        except Exception: pass
        raise RuntimeError(f"{method} {url.split('/')[-1]} -> HTTP {e.code}: {body}") from None



def zip_one(path, arcname):
    """Zip one file, reading its bytes explicitly and checking what came out.

    zipfile.write(path) was intermittently producing a 122-byte archive holding an EMPTY entry for a file
    that is 13KB on disk — a different function each run. Netlify rejected those with "must be a non-empty
    zip", which was accurate and looked like a Netlify fault. Reading the bytes and using writestr is
    deterministic, and the check below turns a silent bad upload into a stop."""
    data = open(path, "rb").read()
    if not data:
        sys.exit(f"{path} is empty on disk — refusing to deploy it")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(arcname, data)
    blob = buf.getvalue()
    if zipfile.ZipFile(io.BytesIO(blob)).getinfo(arcname).file_size != len(data):
        sys.exit(f"zip of {arcname} did not round-trip — refusing to upload a corrupt bundle")
    return blob


def sha1(b):
    return hashlib.sha1(b).hexdigest()


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def main():
    html_only = "--html" in sys.argv
    _, site = req("GET", f"/sites/{SITE}")
    pub = site["published_deploy"]
    _, files = req("GET", f"/deploys/{pub['id']}/files")
    manifest = {f["path"]: f["sha"] for f in files}

    # index.html, plus the static docs served at the site root. sourcing.md is the sourcing instruction the
    # team's Claude Code reads from a URL — it was previously only carried forward by its unchanged hash, so
    # edits to it never actually reached the site.
    idx = open(os.path.join(PROJ, "index.html"), "rb").read()
    manifest["/index.html"] = sha1(idx)
    statics = {}
    for name in ("sourcing.md", "trades.json"):
        fp = os.path.join(PROJ, name)
        if os.path.exists(fp):
            statics[name] = open(fp, "rb").read()
            manifest["/" + name] = sha1(statics[name])

    # function zips — one bare .js per zip, exactly as Netlify expects
    zips, fn_manifest = {}, {}
    if html_only:
        fn_manifest = {f["n"]: f["d"] for f in (pub.get("available_functions") or [])}
    else:
        fdir = os.path.join(PROJ, "netlify", "functions")
        for fn in sorted(os.listdir(fdir)):
            if not fn.endswith(".js"):
                continue
            name = fn[:-3]
            zips[name] = zip_one(os.path.join(fdir, fn), fn)
            fn_manifest[name] = sha256(zips[name])

    print(f"files {len(manifest)} · functions {len(fn_manifest)}"
          f"{' (reusing existing)' if html_only else ''}")

    _, dep = req("POST", f"/sites/{SITE}/deploys", {"files": manifest, "functions": fn_manifest})
    if not dep.get("id"):
        sys.exit("deploy create failed: " + json.dumps(dep)[:300])
    need_files = set(dep.get("required") or [])
    need_fns = set(dep.get("required_functions") or [])

    # Netlify garbage-collects function bundles. When that has happened it asks for every zip back — but in
    # --html mode we never built any, so the deploy hangs and then dies on a connection reset with nothing
    # explaining why. Rebuild the zips and carry on rather than failing.
    if html_only and need_fns:
        print(f"  bundles expired — Netlify wants {len(need_fns)} function(s) back; rebuilding them")
        fdir = os.path.join(PROJ, "netlify", "functions")
        for fn in sorted(os.listdir(fdir)):
            if not fn.endswith(".js"):
                continue
            zips[fn[:-3]] = zip_one(os.path.join(fdir, fn), fn)
    print(f"deploy {dep['id']} · required files {len(need_files)} · required functions {len(need_fns)}")

    if manifest["/index.html"] in need_files:
        s, _ = req("PUT", f"{API}/deploys/{dep['id']}/files/index.html", idx,
                   "application/octet-stream", raw=True)
        print("  index.html →", s)
    for name, blob in statics.items():
        if sha1(blob) in need_files:
            s, _ = req("PUT", f"{API}/deploys/{dep['id']}/files/{name}", blob,
                       "application/octet-stream", raw=True)
            print(f"  {name} → {s}")
    for name, blob in zips.items():
        if sha256(blob) in need_fns:
            # Netlify intermittently rejects an upload with "must be a non-empty zip" — a different function
            # each run, though every zip is valid on disk. Treat it as transient: prove the payload locally,
            # then retry rather than abandoning the whole deploy on one bad round trip.
            if not blob or len(blob) < 100:
                sys.exit(f"refusing to upload {name}: zip is {len(blob)} bytes")
            for attempt in range(1, 5):
                try:
                    st, _ = req("PUT", f"{API}/deploys/{dep['id']}/functions/{name}?runtime=js", blob,
                                "application/zip", raw=True)
                    print(f"  fn {name} → {st}")
                    break
                except RuntimeError as e:
                    if attempt == 4:
                        print(f"  fn {name} ({len(blob)}b) → FAILED after 4 tries: {e}")
                        raise
                    time.sleep(2 * attempt)

    for i in range(60):
        time.sleep(3)
        _, pd = req("GET", f"/deploys/{dep['id']}")
        if pd["state"] in ("ready", "error"):
            print("FINAL:", pd["state"], "|", pd.get("ssl_url") or pd.get("url"))
            if pd.get("error_message"):
                print("error:", pd["error_message"])
            return
        if i % 5 == 0:
            print("  …", pd["state"])
    print("timed out — check Netlify")


if __name__ == "__main__":
    main()
