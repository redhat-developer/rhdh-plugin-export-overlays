"""Tests for scripts/ensure-codecov-cli.sh.

The script's stated contract is that it refuses to leave an unverified binary
behind — the bytes it fetches are about to be executed. That is the part worth
pinning, and it is reachable without a network: a `curl` shim on PATH stands in
for the download, so these exercise the real verification logic against
controlled content rather than whatever cli.codecov.io serves today.

No production seam was added for this. The download URL stays a literal so the
`--proto '=https'` pins remain visible to a reader and to static analysis;
putting a base-URL override into a supply-chain-sensitive script purely for
tests would trade a real property for a testing convenience.
"""

import hashlib
import os
import subprocess

from tests.shell_harness import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "ensure-codecov-cli.sh"

# No escapes: the shim writes it with `printf %s`, so what lands on disk must
# be byte-for-byte what hashlib hashed here.
FAKE_BINARY = "fake-codecov-binary"


def write_failing_curl(bin_dir) -> None:
    """A `curl` that fails loudly, for tests asserting no download happens.

    An empty PATH cannot be used for that — it would break the script's own
    `/usr/bin/env bash` shebang and pass for the wrong reason.
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    shim = bin_dir / "curl"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        'echo "curl was called: $*" >&2\n'
        "exit 99\n"
    )
    shim.chmod(0o755)


def write_curl_shim(bin_dir, checksum) -> None:
    """A `curl` that writes fixed content instead of fetching.

    ensure-codecov-cli.sh fetches the binary and its .SHA256SUM in one
    invocation, so the shim collects every -o target in order: first the binary,
    then the checksum sidecar.
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    shim = bin_dir / "curl"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        "outs=()\n"
        'while [[ $# -gt 0 ]]; do\n'
        '  if [[ "$1" == "-o" ]]; then outs+=("$2"); shift 2; else shift; fi\n'
        "done\n"
        f'printf %s {FAKE_BINARY!r} > "${{outs[0]}}"\n'
        f'printf "%s  codecov\\n" {checksum!r} > "${{outs[1]}}"\n'
        "exit 0\n"
    )
    shim.chmod(0o755)


def run(target, path):
    return subprocess.run(
        [str(SCRIPT), str(target)],
        env={"PATH": path},
        capture_output=True,
        text=True,
        timeout=60,
    )


def system_path(bin_dir) -> str:
    """The shim first, then the real tools the script needs (sha256sum, awk)."""
    return f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}"


def test_an_existing_executable_is_left_alone(tmp_path):
    """The short-circuit every other suite depends on: with CODECOV_BIN pointed
    at a stub, this must not fetch the real CLI over it."""
    stub = tmp_path / "codecov"
    stub.write_text("#!/usr/bin/env bash\nexit 0\n")
    stub.chmod(0o755)
    before = stub.read_text()

    bin_dir = tmp_path / "bin"
    write_failing_curl(bin_dir)

    result = run(stub, path=system_path(bin_dir))

    assert result.returncode == 0, result.stderr
    assert stub.read_text() == before
    assert "Downloading" not in result.stdout
    assert "curl was called" not in result.stderr


def test_a_verified_download_is_kept_and_made_executable(tmp_path):
    target = tmp_path / "codecov"
    bin_dir = tmp_path / "bin"
    write_curl_shim(bin_dir, hashlib.sha256(FAKE_BINARY.encode()).hexdigest())

    result = run(target, path=system_path(bin_dir))

    assert result.returncode == 0, result.stderr
    assert target.read_text() == FAKE_BINARY
    assert os.access(target, os.X_OK)
    assert "downloaded and verified" in result.stdout


def test_a_checksum_mismatch_removes_the_download(tmp_path):
    """The whole point of the script. Leaving a tampered or truncated binary at
    the target would let the next run find it, skip the check, and execute it."""
    target = tmp_path / "codecov"
    bin_dir = tmp_path / "bin"
    write_curl_shim(bin_dir, "0" * 64)

    result = run(target, path=system_path(bin_dir))

    assert result.returncode == 1
    assert not target.exists()
    assert "checksum verification failed" in result.stderr


def test_the_checksum_sidecar_is_not_left_behind(tmp_path):
    """It sits next to the binary in a shared location (/tmp/codecov by
    default), so leaving it turns a temp file into a permanent one."""
    target = tmp_path / "codecov"
    bin_dir = tmp_path / "bin"
    write_curl_shim(bin_dir, hashlib.sha256(FAKE_BINARY.encode()).hexdigest())

    result = run(target, path=system_path(bin_dir))

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "codecov.SHA256SUM").exists()


def test_an_unsupported_os_fails_with_a_named_reason(tmp_path):
    """Better than downloading an artifact that does not exist for the
    platform and failing later on a confusing checksum mismatch."""
    bin_dir = tmp_path / "bin"
    write_curl_shim(bin_dir, "0" * 64)
    fake_uname = bin_dir / "uname"
    fake_uname.write_text("#!/usr/bin/env bash\necho Plan9\n")
    fake_uname.chmod(0o755)

    result = run(tmp_path / "absent", path=system_path(bin_dir))

    assert result.returncode == 1
    assert "Unsupported OS" in result.stderr
