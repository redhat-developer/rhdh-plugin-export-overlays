"""Tests for scripts/extractCatalogIndex.sh.

The script's job is to recover one file from a `FROM scratch` OCI image, and the part
that is easy to get wrong is WHICH copy it recovers: layers are listed base-first, so an
index rebuilt as an overlay keeps a stale copy of dynamic-plugins.default.yaml in a
lower layer, and reading that one validates the PREVIOUS index while reporting on the
current one. That is the behaviour these tests pin down.

No network and no real skopeo: a stub lays down the same `dir:` layout skopeo produces
(a manifest.json plus layer blobs named by their bare sha256 digest), which is exactly
the shape the script parses.
"""

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
EXTRACT_SCRIPT = SCRIPTS_DIR / "extractCatalogIndex.sh"

DPDY = "dynamic-plugins.default.yaml"


def tar_layer(files: dict[str, str], gzipped: bool = False) -> bytes:
    """A layer blob carrying `files`, optionally gzip-compressed as a real layer is."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    return gzip.compress(raw) if gzipped else raw


def build_image_dir(root: Path, layers: list[bytes]) -> None:
    """Write the `dir:` layout skopeo copy produces, base layer first."""
    root.mkdir(parents=True, exist_ok=True)
    manifest_layers = []
    for blob in layers:
        digest = hashlib.sha256(blob).hexdigest()
        (root / digest).write_bytes(blob)
        # Only `.layers[].digest` is read by the script, so the fixture states only
        # that — a mediaType claiming gzip on an uncompressed blob would be the fixture
        # asserting something no code checks.
        manifest_layers.append({"digest": f"sha256:{digest}"})
    (root / "manifest.json").write_text(
        json.dumps({"schemaVersion": 2, "layers": manifest_layers})
    )


def stub_skopeo(bindir: Path, image_dir: Path) -> None:
    """A `skopeo` whose `copy … dir:<dest>` just clones a prepared layout."""
    bindir.mkdir(parents=True, exist_ok=True)
    shim = bindir / "skopeo"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        "# args: copy --override-os linux --override-arch amd64 docker://IMG dir:DEST\n"
        'for arg in "$@"; do\n'
        '  case "$arg" in dir:*) dest="${arg#dir:}";; esac\n'
        "done\n"
        '[[ -n "$dest" ]] || exit 1\n'
        'mkdir -p "$dest"\n'
        f'cp "{image_dir}"/* "$dest"/\n'
    )
    shim.chmod(0o755)


def missing_tool_bindir(bindir: Path, missing: str) -> None:
    """A PATH that has everything the script needs except `missing`.

    `bash` is in the list because the shebang resolves through PATH too: without it the
    run dies at 127 ("env: bash: No such file or directory") and the test would be
    asserting on the harness rather than on the script's own tool check.
    """
    bindir.mkdir(parents=True, exist_ok=True)
    for tool in ("bash", "skopeo", "jq", "tar"):
        if tool == missing:
            continue
        real = shutil.which(tool)
        if real:
            (bindir / tool).symlink_to(real)





def run_extract(tmp_path, layers, dest_name="out.yaml"):
    image_dir = tmp_path / "image"
    build_image_dir(image_dir, layers)
    bindir = tmp_path / "bin"
    stub_skopeo(bindir, image_dir)
    dest = tmp_path / dest_name
    env = {
        "PATH": f"{bindir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "HOME": os.environ.get("HOME", "/tmp"),
    }
    result = subprocess.run(
        [str(EXTRACT_SCRIPT), "quay.io/rhdh/plugin-catalog-index:next", str(dest)],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result, dest


class TestExtraction:
    def test_extracts_the_file_from_a_single_layer(self, tmp_path):
        result, dest = run_extract(
            tmp_path, [tar_layer({DPDY: "plugins:\n  - package: oci://a\n"})]
        )
        assert result.returncode == 0, result.stderr
        assert "package: oci://a" in dest.read_text()

    def test_reads_gzip_compressed_layers(self, tmp_path):
        # Real layers are gzipped; tar auto-detects, but only if the script does not
        # try to be clever about the extension the blobs do not have.
        result, dest = run_extract(
            tmp_path, [tar_layer({DPDY: "plugins: []\n"}, gzipped=True)]
        )
        assert result.returncode == 0, result.stderr
        assert dest.read_text() == "plugins: []\n"

    def test_takes_the_copy_from_the_TOPMOST_layer(self, tmp_path):
        """The whole reason this walks the manifest in reverse.

        A lower layer's stale copy would validate the previous index while the report
        names the current one — a wrong answer that looks like a right one.
        """
        result, dest = run_extract(
            tmp_path,
            [
                tar_layer({DPDY: "stale: true\n"}),
                tar_layer({DPDY: "current: true\n"}),
            ],
        )
        assert result.returncode == 0, result.stderr
        assert dest.read_text() == "current: true\n"

    def test_skips_layers_that_do_not_carry_the_file(self, tmp_path):
        result, dest = run_extract(
            tmp_path,
            [
                tar_layer({DPDY: "wanted: true\n"}),
                tar_layer({"index.json": "{}"}),
            ],
        )
        assert result.returncode == 0, result.stderr
        assert dest.read_text() == "wanted: true\n"

    def test_creates_the_destination_directory(self, tmp_path):
        result, dest = run_extract(
            tmp_path, [tar_layer({DPDY: "plugins: []\n"})], dest_name="nested/out.yaml"
        )
        assert result.returncode == 0, result.stderr
        assert dest.is_file()


class TestFailures:
    def test_a_file_that_is_in_no_layer_fails(self, tmp_path):
        # Silence here would hand the sanity check an empty file and report a clean run
        # over zero packages.
        result, dest = run_extract(tmp_path, [tar_layer({"index.json": "{}"})])
        assert result.returncode == 1
        assert f"{DPDY} not found" in result.stderr
        assert not dest.exists()

    def test_an_empty_copy_is_not_accepted(self, tmp_path):
        result, _ = run_extract(tmp_path, [tar_layer({DPDY: ""})])
        assert result.returncode == 1

    @pytest.mark.parametrize(
        "args", [pytest.param([], id="no_args"), pytest.param(["image"], id="no_dest")]
    )
    def test_missing_arguments_are_rejected(self, args):
        result = subprocess.run(
            [str(EXTRACT_SCRIPT), *args], capture_output=True, text=True, timeout=30
        )
        assert result.returncode == 2
        assert "usage:" in result.stderr

    def test_a_missing_tool_is_named(self, tmp_path):
        """"command not found" halfway through a pull is a worse message than this."""
        bindir = tmp_path / "bin"
        missing_tool_bindir(bindir, "skopeo")
        result = subprocess.run(
            [str(EXTRACT_SCRIPT), "img", str(tmp_path / "out.yaml")],
            env={"PATH": str(bindir), "HOME": os.environ.get("HOME", "/tmp")},
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 2
        assert "needs skopeo" in result.stderr
