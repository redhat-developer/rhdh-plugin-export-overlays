#!/usr/bin/env python3
"""Download E2E test artifacts from a prow URL.

Usage:
    python3 download-artifacts.py <PROW_URL>

Accepts prow or gcsweb URLs for both PR checks and nightly (periodic) runs.
Downloads artifacts via gcloud storage and prints the ARTIFACTS path.

Examples:
    python3 download-artifacts.py https://prow.ci.openshift.org/view/gs/test-platform-results/logs/periodic-ci-...-nightly/123456
    python3 download-artifacts.py https://prow.ci.openshift.org/view/gs/test-platform-results/pr-logs/pull/redhat-developer_.../42/pull-ci-.../123456
"""

import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


def parse_url(url: str) -> dict:
    """Parse a prow or gcsweb URL into its components."""
    parsed = urlparse(url.rstrip("/"))
    path = parsed.path

    # Normalize: strip gcsweb prefix or prow /view/gs/ prefix to get the GCS-relative path
    # prow:   /view/gs/test-platform-results/...
    # gcsweb: /gcs/test-platform-results/...
    for prefix in ["/view/gs/", "/gcs/"]:
        if path.startswith(prefix):
            path = path[len(prefix):]
            break

    parts = path.split("/")

    # PR check: test-platform-results/pr-logs/pull/{org_repo}/{PR}/{job_name}/{job_id}
    if "pr-logs" in parts:
        try:
            pr_idx = parts.index("pull") + 1
            org_repo = parts[pr_idx]  # noqa: F841
            pr_number = parts[pr_idx + 1]
            job_name = parts[pr_idx + 2]
            job_id = parts[pr_idx + 3]
            return {
                "type": "pr",
                "pr": pr_number,
                "job_name": job_name,
                "job_id": job_id,
                "artifact_subdir": job_name.split("-main-")[-1] if "-main-" in job_name else "e2e-ocp-helm",
                "gcs_path": f"gs://test-platform-results/pr-logs/pull/redhat-developer_rhdh-plugin-export-overlays/{pr_number}/{job_name}/{job_id}",
            }
        except (IndexError, ValueError):
            pass

    # Nightly: test-platform-results/logs/{job_name}/{job_id}
    if "/logs/" in "/" + "/".join(parts):
        try:
            logs_idx = parts.index("logs")
            job_name = parts[logs_idx + 1]
            job_id = parts[logs_idx + 2]
            return {
                "type": "nightly",
                "job_name": job_name,
                "job_id": job_id,
                "artifact_subdir": "e2e-ocp-helm-nightly",
                "gcs_path": f"gs://test-platform-results/logs/{job_name}/{job_id}",
            }
        except (IndexError, ValueError):
            pass

    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 download-artifacts.py <PROW_URL>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    info = parse_url(url)
    if not info:
        print(f"ERROR: Could not parse URL: {url}", file=sys.stderr)
        sys.exit(1)

    if info["type"] == "pr":
        cache_dir = Path("node_modules/.cache/e2e-artifacts") / info["pr"] / info["job_id"]
    else:
        cache_dir = Path("node_modules/.cache/e2e-artifacts/nightly") / info["job_id"]

    artifacts_dir = cache_dir / "redhat-developer-rhdh-plugin-export-overlays-ocp-helm" / "artifacts"

    # Skip download if already cached
    if artifacts_dir.exists():
        print(f"Artifacts already downloaded, using cache.", file=sys.stderr)
        print(artifacts_dir)
        sys.exit(0)

    cache_dir.mkdir(parents=True, exist_ok=True)

    gcs_src = (
        f"{info['gcs_path']}/artifacts/{info['artifact_subdir']}"
        f"/redhat-developer-rhdh-plugin-export-overlays-ocp-helm/"
    )

    print(f"Downloading from {gcs_src}", file=sys.stderr)

    result = subprocess.run(
        ["gcloud", "storage", "cp", "-r", gcs_src, str(cache_dir) + "/"],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"ERROR: gcloud storage cp failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    if not artifacts_dir.exists():
        print(f"ERROR: Expected artifacts dir not found: {artifacts_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Download complete.", file=sys.stderr)
    print(artifacts_dir)


if __name__ == "__main__":
    main()
