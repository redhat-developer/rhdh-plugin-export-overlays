"""Tests for renderCatalogIndexIssue.py — the catalog-index sanity failure issue (RHIDP-16694).

The workflow around this creates, deduplicates and labels the issue; none of that is
testable without GitHub. Everything with a judgement in it lives here instead: which
failures reach the body, what a report that never got written says, and — the one the
deduplication depends on — that the title does not move between runs.
"""

import json

import pytest

import renderCatalogIndexIssue as renderer


IMAGE = "quay.io/rhdh/plugin-catalog-index:next"
RUN = "https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/runs/1"


def plugin_error(name, error):
    return {"plugin": {"name": name}, "error": error}


def report(**overrides):
    base = {
        "status": "fail-load",
        "backend": {"errors": [], "bundleErrors": []},
        "frontend": {"errors": [], "configKeyMismatches": []},
    }
    base.update(overrides)
    return base


def test_title_is_stable_across_runs():
    # The deduplication looks an open issue up by this exact string, so a date or a
    # digest in it would file a fresh issue every night the index stays broken — the
    # behaviour the ticket exists to avoid.
    first = renderer.render_title(IMAGE)
    second = renderer.render_title(IMAGE)
    assert first == second
    assert IMAGE in first
    for moving in ("sha256:", "20", "run"):
        assert moving not in first.replace(IMAGE, "")


def test_a_title_with_no_image_still_names_something():
    # Reachable whenever the sanity job dies before resolving the image — the workflow
    # passes its empty output straight through. A title ending in ": " names no index.
    title = renderer.render_title("")
    assert title.rstrip().endswith("(image unresolved)")
    # And it is still a title the deduplication can look up, not a bare prefix.
    assert title != renderer.render_title(IMAGE)


def test_title_separates_two_indexes():
    # A release branch validates its own index. Two broken indexes are two problems and
    # must not share one issue.
    assert renderer.render_title(IMAGE) != renderer.render_title(
        "quay.io/rhdh/plugin-catalog-index:1.10"
    )


def test_body_lists_failures_from_every_section():
    # The job summary prints two of these lists. An issue naming only those sends the
    # reader back to the artifact for the rest, which is what it exists to save them.
    doc = report(
        backend={
            "errors": [plugin_error("@s/loadfail", "No default export")],
            "bundleErrors": [plugin_error("@s/schema", "declares configSchema")],
        },
        frontend={
            "errors": [plugin_error("@s/bundle", "missing plugin-manifest.json")],
            "configKeyMismatches": [{"source": "a.yaml", "key": "scope.typo"}],
        },
    )
    body = renderer.render_body(doc, IMAGE, "sha256:abc", RUN)
    assert "@s/loadfail: No default export" in body
    assert "@s/schema: declares configSchema" in body
    assert "@s/bundle: missing plugin-manifest.json" in body
    assert "a.yaml: configured key 'scope.typo' matches no bundle name" in body
    assert "Failing packages (4)" in body


def test_body_caps_the_list_and_says_how_many_are_left():
    # A wholly broken index fails dozens at once. Sixty identical lines at the top of an
    # issue is read by nobody, so the body has to say what it left out.
    doc = report(
        backend={
            "errors": [plugin_error(f"@s/p{i}", "boom") for i in range(25)],
            "bundleErrors": [],
        }
    )
    body = renderer.render_body(doc, IMAGE, "", RUN)
    assert "@s/p0: boom" in body
    assert "@s/p24: boom" not in body
    assert "and 5 more" in body


def test_the_two_fallback_literals_are_pinned():
    # Neither had a test asserting its text. `unresolved` in particular has to stay in
    # step with the bash fallback in catalog-index-sanity.yaml's "Resolve the catalog
    # index image" step, which writes the same word when skopeo cannot read the tag —
    # two copies of one string, in two languages, is exactly where drift starts.
    body = renderer.render_body(report(status=None), IMAGE, "", RUN)
    assert "`unresolved`" in body
    assert "`unknown`" in body


def test_a_failure_with_no_per_package_error_prints_what_the_report_does_say():
    # writeErrorReport() in native-smoke.ts — bad args, an install-CLI crash, a boot
    # failure before the report is built — emits zero per-package errors and puts the
    # whole root cause in backendStart.error. Naming the causes without printing them
    # made the issue content-free for that entire class.
    body = renderer.render_body(
        report(
            status="error",
            installShortfall="installed 2 plugin(s) but the catalog index declared 3",
            backendStart={"ok": False, "error": "boom during boot"},
        ),
        IMAGE,
        "",
        RUN,
    )
    assert "Install shortfall: installed 2 plugin(s)" in body
    assert "Backend start: boom during boot" in body


def test_the_no_cause_fallback_is_reachable():
    # It was not: the emptiness test compared an absolute length against a list that
    # already held the header, so a report with no failure, no shortfall and no start
    # error rendered "What it does say:" followed by nothing.
    body = renderer.render_body(report(status="error"), IMAGE, "", RUN)
    assert "What it does say:" in body
    assert "Nothing beyond the status above" in body


def test_a_multiline_error_stays_one_bullet_and_is_capped():
    # PluginError.error is a raw err.message, and Node's MODULE_NOT_FOUND spans lines.
    # Newlines break the bullet list, and uncapped messages can push the body past
    # GitHub's 65536-character limit, which fails the create outright.
    long_error = "Cannot find module 'x'\nRequire stack:\n- " + "y" * 500
    body = renderer.render_body(
        report(backend={"errors": [plugin_error("@s/p", long_error)]}),
        IMAGE,
        "",
        RUN,
    )
    bullets = [ln for ln in body.splitlines() if ln.startswith("- @s/p")]
    assert len(bullets) == 1
    assert "Require stack:" in bullets[0]
    assert len(bullets[0]) < 400


def test_a_truthy_non_dict_section_does_not_crash_the_render():
    # An AttributeError here kills the render step, so no issue is filed at all — the
    # opposite of what this script exists for. Verified crashing before the guard.
    assert renderer.collect_failures({"backend": "notadict"}) == []
    assert renderer.collect_failures({"frontend": ["a", "list"]}) == []
    assert renderer.collect_failures(
        {"backend": {"errors": [{"plugin": "a-string", "error": "boom"}]}}
    ) == ["?: boom"]


def test_an_unresolved_image_reads_the_same_in_the_title_and_the_body():
    body = renderer.render_body(report(), "", "", RUN)
    assert "(image unresolved)" in body
    assert "against ``" not in body


def test_a_report_that_was_never_written_still_files_something():
    # The harness not reaching its report stage IS the failure. Staying silent because
    # there is no JSON to read would lose exactly the worst case.
    body = renderer.render_body(None, IMAGE, "sha256:abc", RUN)
    assert "did not reach its report stage" in body
    assert RUN in body


def test_a_failure_outside_the_per_plugin_checks_says_so():
    # An install shortfall or a backend that never started fails the job with no
    # per-package error. "Failing packages (0)" would read as a bug in this renderer.
    body = renderer.render_body(report(status="fail-install"), IMAGE, "", RUN)
    assert "no per-package failure" in body
    assert "Failing packages" not in body


@pytest.mark.parametrize(
    "bad",
    [None, "not-json", json.dumps([1, 2, 3]), json.dumps("a string")],
    ids=["missing", "malformed", "list", "scalar"],
)
def test_load_report_tolerates_anything_on_disk(tmp_path, bad):
    # Read from a failed run's working directory: truncated, absent, or half-written are
    # all reachable, and none may abort the reporting path.
    path = tmp_path / "results.json"
    if bad is not None:
        path.write_text(bad, encoding="utf-8")
    assert renderer.load_report(path) is None


def test_a_file_whose_bytes_are_not_utf8_reads_as_no_report(tmp_path):
    # Not covered by the text cases above: the decode happens on read, so this raises
    # UnicodeDecodeError — a ValueError, NOT an OSError, and not a JSONDecodeError. The
    # artifact comes from a job that just died, which is where a write truncated
    # mid-character comes from.
    path = tmp_path / "results.json"
    path.write_bytes(b'{"status": "\xff\xfe"}')
    assert renderer.load_report(path) is None


def test_collect_failures_skips_entries_that_are_not_objects():
    doc = report(backend={"errors": ["a string", None, plugin_error("@s/p", "boom")]})
    assert renderer.collect_failures(doc) == ["@s/p: boom"]


def test_a_missing_plugin_name_does_not_render_as_an_object(tmp_path):
    # The same trap the job summary's jq comment records: `.plugin` is an object, so a
    # bare fallback dumps the whole thing into the issue.
    doc = report(backend={"errors": [{"plugin": {}, "error": "boom"}]})
    assert renderer.collect_failures(doc) == ["?: boom"]


def run_main(monkeypatch, cwd, **flags):
    """Drive main() from `cwd`, which is where the path confinement is anchored."""
    monkeypatch.chdir(cwd)
    argv = ["renderCatalogIndexIssue.py"]
    for key, value in flags.items():
        argv += [f"--{key.replace('_', '-')}", str(value)]
    monkeypatch.setattr("sys.argv", argv)
    return renderer.main()


def test_main_writes_both_files(tmp_path, monkeypatch):
    (tmp_path / "results.json").write_text(json.dumps(report()), encoding="utf-8")
    rc = run_main(
        monkeypatch,
        tmp_path,
        results="results.json",
        image=IMAGE,
        digest="sha256:abc",
        run_url=RUN,
        title_out="t.txt",
        body_out="b.md",
    )
    assert rc == 0
    assert (tmp_path / "t.txt").read_text(encoding="utf-8") == renderer.render_title(IMAGE)
    assert RUN in (tmp_path / "b.md").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "flag", ["results", "title_out", "body_out"], ids=["read", "title", "body"]
)
def test_a_path_escaping_the_working_directory_is_refused(tmp_path, monkeypatch, flag):
    # Every path here arrives from argv. Confining them is the same rule
    # validateCatalogIndex.py applies through the same helper, and it has to hold for
    # the two OUTPUT paths as much as the input: those are the ones that would write.
    (tmp_path / "results.json").write_text(json.dumps(report()), encoding="utf-8")
    flags = {
        "results": "results.json",
        "image": IMAGE,
        "title_out": "t.txt",
        "body_out": "b.md",
    }
    flags[flag] = "../escaped"
    assert run_main(monkeypatch, tmp_path, **flags) == 2
    assert not (tmp_path.parent / "escaped").exists()
