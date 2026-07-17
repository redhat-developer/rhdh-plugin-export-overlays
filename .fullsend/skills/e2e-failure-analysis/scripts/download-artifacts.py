#!/usr/bin/env python3
"""Download E2E test artifacts from a prow/gcsweb URL via the public GCS JSON API."""

import gzip
import json
import os
import re
import shutil
import ssl
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

BUCKET = "test-platform-results"
API_URL = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o"
DL_URL = f"https://storage.googleapis.com/{BUCKET}"
MAX_WORKERS = 8

EXCLUDE_RE = re.compile(r"\.webm$|/playwright-report/data/|/playwright-report/trace/")
INCLUDE_RE = re.compile(r"/e2e-test-results/.*/trace\.zip$")


def _ssl_ctx():
    for ca in (os.environ.get("SSL_CERT_FILE"), os.environ.get("REQUESTS_CA_BUNDLE"),
               "/etc/openshell-tls/ca-bundle.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if ca and Path(ca).is_file():
            return ssl.create_default_context(cafile=ca)
    return ssl.create_default_context()


CTX = _ssl_ctx()


def parse_url(url):
    path = urlparse(url.rstrip("/")).path
    for pfx in ("/view/gs/", "/gcs/"):
        if path.startswith(pfx):
            path = path[len(pfx):]
            break
    parts = path.split("/")

    if "pr-logs" in parts:
        i = parts.index("pull") + 1
        pr, job, jid = parts[i + 1], parts[i + 2], parts[i + 3]
        sub = job.split("-main-")[-1] if "-main-" in job else "e2e-ocp-helm"
        return {"type": "pr", "pr": pr, "job_id": jid, "subdir": sub,
                "gcs": f"pr-logs/pull/redhat-developer_rhdh-plugin-export-overlays/{pr}/{job}/{jid}"}

    if "/logs/" in "/" + "/".join(parts):
        i = parts.index("logs")
        job, jid = parts[i + 1], parts[i + 2]
        sub = job.split("-main-")[-1] if "-main-" in job else "e2e-ocp-helm-nightly"
        return {"type": "nightly", "job_id": jid, "subdir": sub,
                "gcs": f"logs/{job}/{jid}"}

    return None


def gcs_list(prefix):
    items, token = [], None
    while True:
        p = {"prefix": prefix, "maxResults": "1000"}
        if token:
            p["pageToken"] = token
        with urllib.request.urlopen(f"{API_URL}?{urllib.parse.urlencode(p)}", context=CTX) as r:
            data = json.loads(r.read())
        items.extend(data.get("items", []))
        token = data.get("nextPageToken")
        if not token:
            return items


def download(gcs_prefix, dest):
    dest.mkdir(parents=True, exist_ok=True)

    print("Listing objects...", file=sys.stderr)
    all_items = gcs_list(gcs_prefix + "/")
    keep = [i for i in all_items if INCLUDE_RE.search(i["name"]) or not EXCLUDE_RE.search(i["name"])]
    total_mb = sum(int(i.get("size", 0)) for i in keep) / 1024 / 1024
    print(f"Downloading {len(keep)}/{len(all_items)} files ({total_mb:.1f} MB)...", file=sys.stderr)

    plen = len(gcs_prefix) + 1

    def _dl(item):
        rel = item["name"][plen:]
        local = dest / rel
        local.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(f"{DL_URL}/{urllib.parse.quote(item['name'], safe='/')}", str(local))

    failed = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(_dl, i): i for i in keep}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                failed += 1
                print(f"  FAILED: {futs[f]['name'].split('/')[-1]}: {e}", file=sys.stderr)

    print(f"Done: {len(keep) - failed}/{len(keep)} files.", file=sys.stderr)

    # Decompress gzipped text files (GCS serves them with raw gzip encoding)
    for path in dest.rglob("*"):
        if not path.is_file() or path.suffix in (".zip", ".gz", ".png", ".webm"):
            continue
        with open(path, "rb") as f:
            if f.read(2) != b"\x1f\x8b":
                continue
        tmp = path.with_suffix(path.suffix + ".tmp")
        with gzip.open(path, "rb") as fi, open(tmp, "wb") as fo:
            shutil.copyfileobj(fi, fo)
        tmp.replace(path)


def is_cache_valid(artifacts_dir):
    if not artifacts_dir.exists():
        return False
    has = lambda g: any(artifacts_dir.rglob(g))
    return sum([has("logs/*/pods.txt"), has("results.json"), has("error-context.md")]) >= 2


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 download-artifacts.py <PROW_URL>", file=sys.stderr)
        sys.exit(1)

    info = parse_url(sys.argv[1])
    if not info:
        print(f"ERROR: Could not parse URL: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    base = Path("node_modules/.cache/e2e-artifacts")
    cache_dir = base / info.get("pr", "nightly") / info["job_id"]
    container = "redhat-developer-rhdh-plugin-export-overlays-ocp-helm"
    artifacts_dir = cache_dir / container / "artifacts"

    if is_cache_valid(artifacts_dir):
        print("Artifacts already downloaded, using cache.", file=sys.stderr)
        print(artifacts_dir)
        return

    if cache_dir.exists():
        print("Cache incomplete, re-downloading...", file=sys.stderr)
        shutil.rmtree(cache_dir)

    gcs_src = f"{info['gcs']}/artifacts/{info['subdir']}/{container}"
    download(gcs_src, cache_dir / container)

    if not artifacts_dir.exists():
        print(f"ERROR: Artifacts dir not found: {artifacts_dir}", file=sys.stderr)
        sys.exit(1)

    print("Download complete.", file=sys.stderr)
    print(artifacts_dir)


if __name__ == "__main__":
    main()
