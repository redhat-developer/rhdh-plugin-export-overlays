"""Exercise diagnosis examples and the real post-script without GitHub writes.

These are contract tests, not proof an LLM always follows the prompt. The gh
and gitleaks stand-ins keep handoff/footer tests offline; secret scanning and
GitHub authorization themselves are not under test.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[2]
FULLSEND = ROOT / ".fullsend/rhdh"
PROMPT = FULLSEND / "agents/ci-diagnose.md"
SCHEMA = json.loads((FULLSEND / "schemas/ci-diagnose-result.schema.json").read_text())
SHA = "1" * 40


def finding(classification, suggestion=None):
    result = {
        "name": "publish",
        "type": "status",
        "classification": classification,
        "root_cause": "The new workspace is missing package metadata.",
    }
    if suggestion is not None:
        result["suggestion"] = suggestion
    return result


def diagnosis(checks):
    red = sorted({check["name"] for check in checks})
    classes = {check["classification"] for check in checks}
    state = json.dumps({"sha": SHA, "red": red}, separators=(",", ":"))
    return {
        "pr_number": 123,
        "head_sha": SHA,
        "verdict": "mixed"
        if len(classes) > 1
        else (checks[0]["classification"] if checks else "pending"),
        "summary": "Wait for a maintainer." if checks else "Wait for CI.",
        "checks": checks,
        "comment_body": (
            "<!-- ci-diagnose -->\n### CI Diagnosis\n\n"
            f"<!-- ci-diagnose-state: {state} -->\n"
        ),
    }


def post_offline(tmp_path, result):
    """Run the complete post-script, capturing exactly what it would send."""
    Draft202012Validator(SCHEMA).validate(result)
    output = tmp_path / "iteration-1/output"
    output.mkdir(parents=True)
    (output / "agent-result.json").write_text(json.dumps(result))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, sys\n"
        "a = sys.argv[1:]\n"
        "root = pathlib.Path(os.environ['CAPTURE_DIR'])\n"
        "with (root / 'calls').open('a') as f: f.write(json.dumps(a) + '\\n')\n"
        "if a[:2] == ['pr', 'review']:\n"
        "    (root / 'review').write_text(pathlib.Path(a[a.index('--body-file')+1]).read_text())\n"
        "elif a[0] == 'api' and '--method' in a:\n"
        "    body = next(x[6:] for x in a if x.startswith('body=@'))\n"
        "    (root / 'comment').write_text(pathlib.Path(body).read_text())\n"
        "    print(json.dumps({'id': 42, 'html_url': 'https://github.com/example/repo/pull/123#issuecomment-42'}))\n"
        "elif a[0] == 'api' and a[1].endswith('/pulls/123'):\n"
        f"    pr = {{'head': {{'sha': '{SHA}', 'repo': {{'full_name': 'example/repo'}}}},\n"
        "          'base': {'repo': {'full_name': 'example/repo'}},\n"
        "          'user': {'login': 'fullsend-ai-coder[bot]'}}\n"
        "    print(pr['head']['sha'] if '--jq' in a else json.dumps(pr))\n"
        "elif a[0] == 'api' and a[1].endswith('/labels'): pass\n"
        "elif a[0] == 'api' and a[1].endswith(('/comments', '/reviews')): print('[]')\n"
        "else: sys.exit('unexpected gh call: ' + repr(a))\n"
    )
    gh.chmod(0o755)
    scanner = bin_dir / "gitleaks"
    scanner.write_text("#!/bin/sh\nexit 0\n")
    scanner.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "GH_TOKEN": "offline-test",
        "REPO_FULL_NAME": "example/repo",
        "CAPTURE_DIR": str(tmp_path),
    }
    run = subprocess.run(
        ["bash", str(FULLSEND / "scripts/post-ci-diagnose.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    return tmp_path


@pytest.mark.parametrize("classification", ["pr_regression", "pre_existing", "flake"])
def test_actionable_findings_require_suggestion(classification):
    with pytest.raises(ValidationError):
        Draft202012Validator(SCHEMA).validate(diagnosis([finding(classification)]))


@pytest.mark.skipif(
    shutil.which("jq") is None, reason="jq is required by the post-script"
)
@pytest.mark.parametrize(
    "reason", ["unknown metadata version", "cluster decision", "rebase onto main"]
)
def test_human_decisions_post_but_never_handoff(tmp_path, reason):
    check = finding("needs_human")
    check["root_cause"] = reason
    capture = post_offline(tmp_path, diagnosis([check]))
    assert (capture / "comment").exists()
    assert not (capture / "review").exists()
    assert "reviews" not in (capture / "calls").read_text()


@pytest.mark.skipif(
    shutil.which("jq") is None, reason="jq is required by the post-script"
)
def test_handoff_receives_suggestion_and_root_cause_not_comment_or_evidence(tmp_path):
    check = finding(
        "pr_regression", "Create the package metadata. Verify with /publish."
    )
    check["evidence"] = "evidence-only-sentinel"
    result = diagnosis([check, finding("needs_human")])
    result["comment_body"] = result["comment_body"].replace(
        "### CI Diagnosis", "### comment-only-sentinel"
    )
    capture = post_offline(tmp_path, result)
    review = (capture / "review").read_text()
    assert check["suggestion"] in review
    assert check["root_cause"] in review
    assert "evidence-only-sentinel" not in review
    assert "comment-only-sentinel" not in review
    assert review.count("### `publish`") == 1


@pytest.mark.skipif(
    shutil.which("jq") is None, reason="jq is required by the post-script"
)
def test_pending_comment_gets_exactly_one_footer_and_ends_with_state(tmp_path):
    result = diagnosis([])
    result["comment_body"] = result["comment_body"].replace(
        '"red":[]', '"red":[],"pending":["publish"]'
    )
    capture = post_offline(tmp_path, result)
    body = (capture / "comment").read_text()
    assert body.count("<sub>Automated CI diagnosis") == 1
    assert body.rstrip().endswith("-->")
    assert body.count("<!-- ci-diagnose-state:") == 1
    assert "{{COMMENT_LINK}}" not in body


def test_template_diff_applies_and_rejects_the_old_bad_counts(tmp_path):
    patch = re.search(r"```diff\n(.*?)```", PROMPT.read_text(), re.S).group(1)
    patch = patch.replace("<workspace>", "example")
    target = tmp_path / "workspaces/example/e2e-tests/tests/support/test-helper.ts"
    target.parent.mkdir(parents=True)
    target.write_text(
        "\n" * 54 + "  const allowedModels = readAllowedModels(config);\n"
        "  const providers = config.providers?.inference;\n"
        '  const provider = providers?.find((p) => p.type === "remote::openai");\n'
    )
    for content, expected in [
        (patch, 0),
        (patch.replace("-55,3 +55,3", "-55,7 +55,7"), 128),
    ]:
        run = subprocess.run(
            ["git", "apply", "--check", "-"],
            input=content,
            cwd=tmp_path,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert run.returncode == expected, run.stderr


@pytest.mark.parametrize("base,version", [("main", "next"), ("release-2.1", "2.1")])
def test_nightly_command_clears_inherited_pr_number(tmp_path, base, version):
    # Execute the actual command in the prompt, replacing only the runner with
    # an env dumper. No dependencies, secrets, cluster or published images used.
    text = PROMPT.read_text()
    command = re.search(r"`(env -u GIT_PR_NUMBER [^`]+)`", text).group(1)
    command = (
        command.replace("<base>", base)
        .replace("<version>", version)
        .replace("<workspace>", "example")
    )
    runner = tmp_path / "run-e2e.sh"
    runner.write_text(
        '#!/bin/sh\nprintf "%s|%s|%s|%s" "${GIT_PR_NUMBER-unset}" "$E2E_NIGHTLY_MODE" "$RELEASE_BRANCH_NAME" "$RHDH_VERSION"\n'
    )
    runner.chmod(0o755)
    run = subprocess.run(
        ["bash", "-c", command],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        timeout=10,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GIT_PR_NUMBER": "4040"},
    )
    assert run.returncode == 0, run.stderr
    assert run.stdout == f"unset|true|{base}|{version}"
