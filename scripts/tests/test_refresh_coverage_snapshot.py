"""Tests for the download step of scripts/refresh-coverage-snapshot.sh.

This step reads an HTML directory listing and decides which files are the run's
coverage. Both of its failure modes are silent by nature: a name it cannot match
looks the same as a run that produced no coverage, and a file that downloads as
an error page looks the same as one that downloaded fine until `nyc merge`
quietly skips it. Either way the snapshot ends up empty and the only symptom is
a remap complaining about instrumentation that was actually fine.

Both happened together on 2026-08-09. e2e-test-utils 2.1.8 renamed the files
from `<testId>-<timestamp>.json` to `w0-page0.json`, the hex-only pattern carved
`e0.json` out of `w0-pag(e0).json`, and gcsweb answered that nonexistent name
with HTTP 200 and an HTML page, so `curl -f` never fired.

A local HTTP server stands in for gcsweb, serving the same listing shape and the
same soft-404 behaviour, so these run without network access.
"""

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tests.shell_harness import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "refresh-coverage-snapshot.sh"

# Real coverage is megabytes of istanbul counters; nothing here parses it, and
# the script only needs it to be a JSON object.
COVERAGE_BODY = json.dumps({"/src/plugin.tsx": {"path": "/src/plugin.tsx"}})

# gcsweb wraps each name in an anchor. The listing carries the full path, which
# is why a pattern anchored on the extension alone can match a fragment.
LISTING = """<!doctype html><html><body>
<a href="/gcs/bucket/run/artifacts/coverage/{first}">{first}</a>
<a href="/gcs/bucket/run/artifacts/coverage/{second}">{second}</a>
</body></html>"""

SOFT_404 = "<!doctype html><html><body>no such object</body></html>"


class _Handler(BaseHTTPRequestHandler):
    listed: tuple = ()
    available: tuple = ()
    broken: tuple = ()

    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        path = self.path.rstrip("/")
        name = path.rsplit("/", 1)[-1]
        if name in self.broken:
            # A real HTTP failure, the one case `curl -f` does catch.
            self.send_response(500)
            self.end_headers()
            return
        if path.endswith("coverage"):
            body = LISTING.format(first=self.listed[0], second=self.listed[1])
        elif name in self.available:
            body = COVERAGE_BODY
        else:
            # The behaviour that defeats `curl -f`: a miss is still a 200.
            body = SOFT_404
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


@pytest.fixture
def listing_server():
    """Serve a coverage listing, with control over which names actually exist.

    `listed` is what the directory page advertises; `available` is what really
    downloads. They differ on purpose — a name present in one and absent from
    the other is the shape of both bugs under test.
    """
    servers = []

    def factory(listed, available=None, broken=()):
        handler = type(
            "Handler",
            (_Handler,),
            {
                "listed": tuple(listed),
                "available": tuple(listed if available is None else available),
                "broken": tuple(broken),
            },
        )
        server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_port}/coverage"

    yield factory
    for server in servers:
        server.shutdown()


DOWNLOAD_SCRIPT = SCRIPT.parent / "download-coverage-json.sh"


def download_only(url, tmp_path, path=None):
    """Run the download step.

    This used to slice the download block out of refresh-coverage-snapshot.sh by
    literal source markers, because the rest of that script needs npm and the
    real workspace layout. The block is now its own script shared with the
    upstream upload path, so these run the real thing — the assertions no longer
    depend on the source text keeping a particular shape.
    """
    env = None
    if path is not None:
        env = {"PATH": path}
    return subprocess.run(
        ["bash", str(DOWNLOAD_SCRIPT), url, f"{tmp_path}/out"],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )


def downloaded(tmp_path):
    out = tmp_path / "out"
    return sorted(p.name for p in out.glob("*.json")) if out.exists() else []


class TestFileNames:
    def test_collects_the_current_per_page_names(self, listing_server, tmp_path):
        """The regression: `w0-page0.json` yielded `e0.json` under a hex-only
        pattern, so the run downloaded a file that does not exist and the real
        coverage was never fetched."""
        url = listing_server(["w0-page0.json", "w1-page0.json"])

        result = download_only(url, tmp_path)

        assert result.returncode == 0, result.stderr
        assert downloaded(tmp_path) == ["w0-page0.json", "w1-page0.json"]

    def test_still_collects_the_previous_hex_names(self, listing_server, tmp_path):
        """Older passing runs are still refreshed from, so the previous naming
        has to keep working — the post-merge job reads PRs weeks back."""
        url = listing_server(["a1b2c3d4-1754000000.json", "e5f6a7b8-1754000001.json"])

        result = download_only(url, tmp_path)

        assert result.returncode == 0, result.stderr
        assert downloaded(tmp_path) == [
            "a1b2c3d4-1754000000.json",
            "e5f6a7b8-1754000001.json",
        ]


class TestErrorPages:
    def test_discards_a_name_that_serves_an_error_page(
        self, listing_server, tmp_path
    ):
        """gcsweb answers a missing object with 200 and HTML, so `curl -f`
        cannot tell the difference. Written to disk it becomes a file `nyc
        merge` skips without a word, and the snapshot comes back empty with
        nothing pointing at the cause."""
        url = listing_server(
            ["w0-page0.json", "not-uploaded.json"], available=["w0-page0.json"]
        )

        result = download_only(url, tmp_path)

        assert result.returncode == 0, result.stderr
        assert downloaded(tmp_path) == ["w0-page0.json"]
        # On stderr, with the other diagnostics — stdout carries the [INFO]
        # progress a caller may parse.
        assert "not-uploaded.json is not JSON" in result.stderr

    def test_a_real_http_failure_is_fatal(self, listing_server, tmp_path):
        """The one failure `curl -f` does catch. Unlike a soft 404 this means
        the artifact store is unreachable or broken, so continuing would
        snapshot a partial run as if it were complete."""
        url = listing_server(
            ["w0-page0.json", "w1-page0.json"], broken=["w1-page0.json"]
        )

        result = download_only(url, tmp_path)

        assert result.returncode == 1
        assert "failed to download w1-page0.json" in result.stderr

    def test_fails_when_every_name_serves_an_error_page(
        self, listing_server, tmp_path
    ):
        """Nothing usable downloaded means the listing format moved. Exiting 0
        here would report success for an empty snapshot, which is how the
        original bug stayed invisible."""
        url = listing_server(["ghost-a.json", "ghost-b.json"], available=[])

        result = download_only(url, tmp_path)

        assert result.returncode == 1
        assert "none of them downloaded as JSON" in result.stderr


class TestTransportSecurity:
    """The loopback exception is what lets the tests above use a local server.
    It also widens a security control — the artifacts decide what coverage gets
    published — so the boundary of that exception is worth pinning.
    """

    def test_plaintext_http_is_refused(self, tmp_path):
        result = download_only("http://example.com/coverage/", tmp_path)

        assert result.returncode == 1
        assert "refusing to download over insecure HTTP" in result.stderr

    def test_a_host_that_merely_starts_with_the_loopback_address_is_refused(
        self, tmp_path
    ):
        """`http://127.0.0.1.evil.com/` must not satisfy the exception. The
        alternation is anchored with a following `[:/]` or end-of-string for
        exactly this — a prefix match would hand an attacker the plaintext
        path the check exists to close."""
        result = download_only("http://127.0.0.1.evil.com/coverage/", tmp_path)

        assert result.returncode == 1
        assert "refusing to download over insecure HTTP" in result.stderr

    def test_a_non_url_source_is_refused(self, tmp_path):
        """The helper only handles URLs; callers pass local directories through
        without it."""
        result = download_only("/tmp/some/dir", tmp_path)

        assert result.returncode == 1
        assert "refusing to download over insecure HTTP" in result.stderr


class TestPrerequisites:
    def test_a_missing_jq_says_so(self, listing_server, tmp_path):
        """Without the check, `if ! jq` reads the 127 from a missing binary as
        "not JSON", discards every file, and the run blames the server — the
        same disguised failure this script was fixed for."""
        url = listing_server(["w0-page0.json", "w1-page0.json"])
        # A PATH with the real tools but no jq, so only that one is missing.
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        for tool in ("curl", "grep", "sort", "rm", "mkdir", "bash", "compgen"):
            found = shutil.which(tool)
            if found:
                (bin_dir / tool).symlink_to(found)

        result = download_only(url, tmp_path, path=str(bin_dir))

        assert result.returncode == 1
        assert "jq is required" in result.stderr


class TestEmptyRun:
    def test_a_listing_with_no_json_is_not_an_error(self, listing_server, tmp_path):
        """A backend-only or uninstrumented run legitimately produces no
        coverage, and a passing e2e must not be turned red by it."""
        url = listing_server(["build-log.txt", "report.html"])

        result = download_only(url, tmp_path)

        assert result.returncode == 0, result.stderr
        assert downloaded(tmp_path) == []
        assert "No coverage JSONs" in result.stdout
