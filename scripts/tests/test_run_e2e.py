import shutil
import subprocess
from pathlib import Path


RUNNER = Path(__file__).resolve().parents[2] / "run-e2e.sh"


def _write_stub(bin_dir: Path, name: str, body: str) -> None:
    stub = bin_dir / name
    stub.write_text(f"#!/usr/bin/env bash\n{body}\n")
    stub.chmod(0o755)


def _run_runner(tmp_path: Path, node_version: str) -> subprocess.CompletedProcess:
    root = tmp_path / "repo"
    bin_dir = root / "bin"
    workspace = root / "workspaces" / "quay" / "e2e-tests"
    bin_dir.mkdir(parents=True)
    workspace.mkdir(parents=True)

    shutil.copy2(RUNNER, root / "run-e2e.sh")
    (root / "versions.json").write_text('{"node":"24.19.0"}\n')
    (workspace / "package.json").write_text('{"name":"quay-e2e"}\n')
    (workspace / "playwright.config.ts").write_text(
        'export default { projects: [{ name: "quay" }] };\n'
    )

    _write_stub(bin_dir, "node", f'[[ "$1" == "--version" ]] && printf "{node_version}\\n"')
    _write_stub(
        bin_dir,
        "yarn",
        'if [[ "$1" == "--version" ]]; then printf "4.17.1\\n"; else exit 0; fi',
    )
    _write_stub(bin_dir, "jq", 'printf "24.19.0\\n"')
    _write_stub(bin_dir, "npx", "exit 0")

    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "CI": "false"}
    return subprocess.run(
        [str(root / "run-e2e.sh"), "--list", "-w", "quay"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_accepts_node_patch_version_with_matching_major_minor(tmp_path):
    result = _run_runner(tmp_path, "v24.19.7")

    assert result.returncode == 0, result.stdout + result.stderr
