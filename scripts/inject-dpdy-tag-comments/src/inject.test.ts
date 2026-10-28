import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { describeError, inject, main } from "./inject.ts";

const FIXTURES_ROOT = join(import.meta.dirname, "..", "fixtures");

async function createTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "inject-dpdy-test-"));
}

async function copyFixture(relPath: string, destPath: string): Promise<void> {
  const src = join(FIXTURES_ROOT, relPath);
  await mkdir(dirname(destPath), { recursive: true });
  await cp(src, destPath);
}

async function copyDpdyFixture(name: string, root: string): Promise<string> {
  const dest = join(root, "dpdy.yaml");
  await copyFixture(join("dpdy", name), dest);
  return dest;
}

async function copyPluginBuildsTree(root: string): Promise<string> {
  const dest = join(root, "plugin_builds");
  await cp(join(FIXTURES_ROOT, "plugin_builds"), dest, { recursive: true });
  return dest;
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function createMainTestHarness() {
  const exit = vi.fn<typeof process.exit>();
  const stderrChunks: string[] = [];
  let stderrWrite: { mockRestore: () => void } | undefined;

  return {
    exit,
    install() {
      exit.mockClear();
      stderrChunks.length = 0;
      process.exit = exit;
      stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
    },
    restore() {
      stderrWrite?.mockRestore();
      stderrWrite = undefined;
    },
    async run(argv: string[]) {
      await main(argv);
    },
    stderr() {
      return stderrChunks.join("");
    },
  };
}

describe("inject", () => {
  it("leaves oci package lines unchanged when the image is not in plugin builds", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("oci-plugin-not-in-builds.yaml", root);
    const builds = await copyPluginBuildsTree(root);
    const before = await readText(dpdy);

    expect(await inject(dpdy, builds)).toBe(false);
    expect(await readText(dpdy)).toBe(before);
    expect(before).not.toContain("# Tag:");
  });

  it("injects tag comment before single oci digest package line", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);

    const out = await readText(dpdy);
    expect(out).toContain("  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n");
    expect(out.indexOf("# Tag:")).toBeLessThan(out.indexOf("- package:"));
  });

  it("is idempotent when tag comment already present", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("already-tagged-idempotent.yaml", root);
    const builds = await copyPluginBuildsTree(root);
    const before = await readText(dpdy);

    expect(await inject(dpdy, builds)).toBe(false);
    expect(await readText(dpdy)).toBe(before);
  });

  it("skips injection for package line immediately after a # Tag: line", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("tag-line-then-fresh-package.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);

    const out = await readText(dpdy);
    const catalogIdx = out.indexOf("red-hat-developer-hub-backstage-plugin-catalog");
    const scaffolderIdx = out.indexOf("red-hat-developer-hub-backstage-plugin-scaffolder");
    expect(out.slice(0, catalogIdx)).not.toMatch(/# Tag: 1\.11--1\.5\.4/);
    expect(out.slice(0, scaffolderIdx)).toMatch(/# Tag: 2\.0\.0-rc\.1, Build date: 2025-06-15/);
  });

  it("blocks only the next package when tag comment is indented", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("indented-tag-comment.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(false);
    expect(await readText(dpdy)).not.toMatch(/# Tag: 1\.11--1\.5\.4/);
  });

  it("preserves pluginConfig and injects for short image alias", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("short-image-name-with-plugin-config.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);

    const out = await readText(dpdy);
    expect(out).toContain("pluginConfig:");
    expect(out).toContain("  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n");
  });

  it("handles oci with exclamation plugin path", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("oci-with-exclamation-plugin-path.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);
    expect(await readText(dpdy)).toContain("  # Tag: 3.1.0-beta, Build date: 2025-04-20\n");
  });

  it("skips npm package lines and injects only oci lines", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("mixed-oci-and-npm.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);

    const out = await readText(dpdy);
    expect(out).not.toMatch(/# Tag:.*scaffolder-backend/);
    expect(out).toContain("  # Tag: 2.0.0-rc.1, Build date: 2025-06-15\n");
  });

  it("does not match package lines with wrong indent", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("wrong-indent-no-match.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);

    const out = await readText(dpdy);
    const threeSpaceLine = out.indexOf("   - package:");
    const catalogOnWrongLine = out.slice(threeSpaceLine, threeSpaceLine + 200);
    expect(catalogOnWrongLine).not.toMatch(/# Tag: 1\.11/);
    expect(out).toContain("  # Tag: 2.0.0-rc.1, Build date: 2025-06-15\n");
  });

  it("handles file without trailing newline", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("no-trailing-newline.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);
    expect(await readText(dpdy)).toMatch(/# Tag: 1\.11--1\.5\.4/);
  });

  it("preserves CRLF line endings", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("crlf-line-endings.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    expect(await inject(dpdy, builds)).toBe(true);
    const out = await readText(dpdy);
    expect(out.includes("\r\n")).toBe(true);
    expect(out).toMatch(/# Tag: 1\.11--1\.5\.4/);
  });

  it("throws when dpdy file is missing", async () => {
    const root = await createTempRoot();
    const builds = await copyPluginBuildsTree(root);

    await expect(inject(join(root, "missing.yaml"), builds)).rejects.toThrow("DPDY file not found");
  });

  it("leaves invalid oci package values unchanged", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("oci-invalid-reference.yaml", root);
    const builds = await copyPluginBuildsTree(root);
    const before = await readText(dpdy);

    expect(await inject(dpdy, builds)).toBe(false);
    expect(await readText(dpdy)).toBe(before);
  });

  it("warns and skips invalid plugin build files and entries", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);
    const builds = await copyPluginBuildsTree(root);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await inject(dpdy, builds);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping invalid plugin build file"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invalid plugin entry "plugin-no-tag"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invalid plugin entry "plugin-bad-build-date"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invalid plugin entry "plugin-bad-registry"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invalid plugin entry "plugin-empty-tag-ok"'),
    );

    warn.mockRestore();
  });

  it("throws when plugin builds directory is missing", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);

    await expect(inject(dpdy, "/nonexistent/plugin_builds")).rejects.toThrow(
      "Plugin builds directory not found",
    );
  });

  it("throws when plugin builds contain no valid tags", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);
    const empty = join(root, "empty_builds", "ws");
    await mkdir(empty, { recursive: true });

    await expect(inject(dpdy, join(root, "empty_builds"))).rejects.toThrow(
      "No plugin build tags found",
    );
  });

  it("skips plugin build JSON files that cannot be parsed", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);
    const buildsDir = join(root, "plugin_builds", "backstage");
    await mkdir(buildsDir, { recursive: true });
    await writeFile(join(buildsDir, "broken.json"), "{not-json", "utf8");
    await writeFile(
      join(buildsDir, "catalog.json"),
      JSON.stringify({
        "red-hat-developer-hub-backstage-plugin-catalog": {
          registryReference: "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-catalog:1.0",
          "build-date": "2025-05-01",
        },
      }),
      "utf8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await inject(dpdy, join(root, "plugin_builds"))).toBe(true);
    expect(await readText(dpdy)).toContain("  # Tag: 1.0, Build date: 2025-05-01\n");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping invalid plugin build file"),
    );

    warn.mockRestore();
  });
});

describe("describeError", () => {
  it("uses Error message", () => {
    expect(describeError(new Error("DPDY file not found"))).toBe("DPDY file not found");
  });

  it("stringifies non-Error values", () => {
    expect(describeError("plain failure")).toBe("plain failure");
  });
});

describe("main", () => {
  const harness = createMainTestHarness();

  beforeEach(() => harness.install());
  afterEach(() => harness.restore());

  it("prints usage and exits 0 for --help", async () => {
    await harness.run(["--help"]);
    expect(harness.stderr()).toContain("Usage: inject-dpdy-tag-comments");
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it("prints usage and exits 0 for -h", async () => {
    await harness.run(["-h"]);
    expect(harness.stderr()).toContain("Usage: inject-dpdy-tag-comments");
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it("prints usage and exits 1 when positionals are missing", async () => {
    await harness.run([]);
    expect(harness.stderr()).toContain("Usage: inject-dpdy-tag-comments");
    expect(harness.exit).toHaveBeenCalledWith(1);

    await harness.run(["only-one-arg"]);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("runs inject successfully", async () => {
    const root = await createTempRoot();
    const dpdy = await copyDpdyFixture("single-oci-digest.yaml", root);
    const builds = await copyPluginBuildsTree(root);

    await harness.run([dpdy, builds]);

    expect(harness.exit).not.toHaveBeenCalled();
    expect(harness.stderr()).toBe("");
  });

  it("surfaces inject errors on stderr and exits 1", async () => {
    await harness.run(["/no/such/dpdy.yaml", "/no/such/builds"]);

    expect(harness.stderr()).toMatch(/^Error: DPDY file not found/);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });
});

describe("import.meta.main entry", () => {
  it("executes main when loaded as the program entry", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = join(import.meta.dirname, "inject.ts");

    const result = spawnSync(process.execPath, [script, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Usage: inject-dpdy-tag-comments");
  });
});
