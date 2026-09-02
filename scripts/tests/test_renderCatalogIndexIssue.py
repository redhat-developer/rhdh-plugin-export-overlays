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
    assert renderer.render_title("") == renderer.render_title("")


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
    assert renderer.load_report(str(path)) is None


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
