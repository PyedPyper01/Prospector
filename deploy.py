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
    with urllib.request.urlopen(r, context=CTX, timeout=180) as resp:
        txt = resp.read()
        return resp.status, (json.loads(txt) if txt and not raw else txt)


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
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                z.write(os.path.join(fdir, fn), arcname=fn)
            zips[name] = buf.getvalue()
            fn_manifest[name] = sha256(zips[name])

    print(f"files {len(manifest)} · functions {len(fn_manifest)}"
          f"{' (reusing existing)' if html_only else ''}")

    _, dep = req("POST", f"/sites/{SITE}/deploys", {"files": manifest, "functions": fn_manifest})
    if not dep.get("id"):
        sys.exit("deploy create failed: " + json.dumps(dep)[:300])
    need_files = set(dep.get("required") or [])
    need_fns = set(dep.get("required_functions") or [])
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
            s, _ = req("PUT", f"{API}/deploys/{dep['id']}/functions/{name}?runtime=js", blob,
                       "application/octet-stream", raw=True)
            print(f"  fn {name} → {s}")

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
