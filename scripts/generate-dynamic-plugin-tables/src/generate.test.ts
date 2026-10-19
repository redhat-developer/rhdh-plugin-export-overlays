/*
 * Copyright (c) Red Hat, Inc.
 * SPDX-License-Identifier: EPL-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { stringify as stringifyYaml } from "yaml";
import { CSV_COLUMNS, renderTables, requireContained } from "./generate.ts";

const temporaryDirs: string[] = [];

function temporaryIndex(): string {
  const directory = mkdtempSync(join(tmpdir(), "plugin-table-"));
  temporaryDirs.push(directory);
  mkdirSync(join(directory, "catalog-entities/extensions/packages"), { recursive: true });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("table generator paths", () => {
  it("accepts missing output directories beneath the selected root", () => {
    const root = temporaryIndex();
    expect(requireContained("--output-dir", ".", root)).toBe(root);
    expect(requireContained("--output-dir", "nested/docs", root)).toBe(
      join(root, "nested", "docs"),
    );
    expect(requireContained("--output-dir", `../${basename(root)}/docs`, root)).toBe(
      join(root, "docs"),
    );
  });

  it("rejects paths that escape the root directly or through a symlink", () => {
    const root = temporaryIndex();
    const outside = temporaryIndex();
    expect(() => requireContained("--index-dir", outside, root)).toThrow(
      /--index-dir must resolve inside/,
    );
    expect(() => requireContained("--output-dir", `${root}-sibling`, root)).toThrow(
      /--output-dir must resolve inside/,
    );
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(() => requireContained("--output-dir", "linked/docs", root)).toThrow(
      /--output-dir must resolve inside/,
    );
  });
});

type PackageOptions = {
  support: string;
  reference?: string;
  content?: string;
  role?: string;
};

/** org-foo -> @org/foo Package entity, including its resolved OCI reference. */
function addPackage(directory: string, name: string, options: PackageOptions): void {
  const { support, content = "", role = "frontend-plugin" } = options;
  const reference = options.reference ?? `oci://ghcr.io/org/${name}@sha256:abc123`;
  const entity = {
    kind: "Package",
    metadata: {
      name,
      title: name.replace(/^org-/, "").replace(/^./, (letter) => letter.toUpperCase()),
    },
    spec: {
      packageName: `@org/${name.replace(/^org-/, "")}`,
      dynamicArtifact: reference,
      version: "1.2.3",
      support,
      lifecycle: "active",
      backstage: { role },
      appConfigExamples: [{ content }],
    },
  };
  writeFileSync(
    join(directory, "catalog-entities/extensions/packages", `${name}.yaml`),
    stringifyYaml(entity),
  );
}

function addIndex(directory: string, entries: Record<string, object>): void {
  writeFileSync(join(directory, "index.json"), JSON.stringify(entries));
}

function indexEntry(name: string, support: string, registry = "ghcr.io/org"): object {
  return {
    registryReference: `${registry}/${name}@sha256:abc123`,
    imageTag: "bs_1.54.9__1.2.3",
    support,
  };
}

function addDefaults(directory: string, enabled: string[], disabled: string[]): void {
  writeFileSync(
    join(directory, "default.packages.yaml"),
    stringifyYaml({
      packages: {
        enabled: enabled.map((name) => ({ package: `@org/${name}` })),
        disabled: disabled.map((name) => ({ package: `@org/${name}` })),
      },
    }),
  );
}

describe("generate dynamic plugin tables", () => {
  it("selects only indexed community packages and writes matching page and CSV rows", () => {
    const directory = temporaryIndex();
    addIndex(directory, { "org-foo": indexEntry("org-foo", "community") });
    addPackage(directory, "org-foo", {
      support: "community",
      content: "token: ${TOKEN}\nother: ${ALPHA}\nagain: ${TOKEN}",
    });
    addPackage(directory, "org-unselected", { support: "community" });

    const outputs = renderTables("community", directory);
    expect(Object.keys(outputs).toSorted()).toEqual([
      "ref-community-supported-plugins.adoc",
      "rhdh-community-plugins.csv",
    ]);
    const page = outputs["ref-community-supported-plugins.adoc"]!;
    expect(page).toContain("following 1 dynamic plugins");
    expect(page).toContain("|*Foo*");
    expect(page).toContain("|`oci://ghcr.io/org/org-foo@sha256:abc123`");
    expect(page).toContain("|bs_1.54.9__1.2.3");
    expect(page.indexOf("`ALPHA`")).toBeLessThan(page.indexOf("`TOKEN`"));
    expect(page.match(/`TOKEN`/g)).toHaveLength(1);
    expect(page).not.toContain("Unselected");
    expect(outputs["rhdh-community-plugins.csv"]).toBe(
      '"Name","Plugin","Role","Version","Support Level","Lifecycle","Path","Required Variables","Default"\n' +
        '"Foo","@org/foo","Frontend","1.2.3","Community Support","active","oci://ghcr.io/org/org-foo@sha256:abc123","`ALPHA`;`TOKEN`","N/A"\n',
    );
  });

  it("labels Developer Preview separately in the community CSV", () => {
    const directory = temporaryIndex();
    addIndex(directory, { "org-preview": indexEntry("org-preview", "dev-preview") });
    addPackage(directory, "org-preview", { support: "dev-preview", role: "backend-plugin" });

    const outputs = renderTables("community", directory);
    expect(outputs["rhdh-community-plugins.csv"]).toContain(
      '"Preview","@org/preview","Backend","1.2.3","Developer Preview"',
    );
    expect(outputs["ref-community-supported-plugins.adoc"]).toContain("|*Preview*");
  });

  it.each(["ghcr.io/org", "quay.io/rhdh", "registry.access.redhat.com/rhdh"])(
    "uses the %s index references and defaults for supported pages",
    (registry) => {
      const directory = temporaryIndex();
      addIndex(directory, {
        "org-ga": indexEntry("org-ga", "generally-available", registry),
        "org-tp": indexEntry("org-tp", "tech-preview", registry),
      });
      addPackage(directory, "org-ga", {
        support: "generally-available",
        reference: `oci://${registry}/org-ga@sha256:abc123`,
      });
      addPackage(directory, "org-tp", {
        support: "tech-preview",
        reference: `oci://${registry}/org-tp@sha256:abc123`,
        content: "key: ${API_KEY}",
      });
      addPackage(directory, "org-unselected", { support: "generally-available" });
      addDefaults(directory, ["ga"], ["tp", "unselected"]);

      const outputs = renderTables("supported", directory);
      expect(Object.keys(outputs).toSorted()).toEqual([
        "con-preinstalled-dynamic-plugins.adoc",
        "ref-deprecated-plugins.adoc",
        "ref-ga-plugins.adoc",
        "ref-technology-preview-plugins.adoc",
        "rhdh-supported-plugins.csv",
      ]);
      expect(outputs["ref-ga-plugins.adoc"]).toContain(`oci://${registry}/org-ga@sha256:abc123`);
      expect(outputs["ref-technology-preview-plugins.adoc"]).toContain("`API_KEY`");
      expect(outputs["con-preinstalled-dynamic-plugins.adoc"]).toContain("* `@org/ga`");
      expect(outputs["con-preinstalled-dynamic-plugins.adoc"]).toContain(
        `Skipping disabled dynamic plugin oci://${registry}/org-tp@sha256:abc123`,
      );
      expect(Object.values(outputs).join("")).not.toContain("Unselected");
      const csv = outputs["rhdh-supported-plugins.csv"]!;
      expect(csv.trimEnd().split("\n")).toHaveLength(3);
      expect(csv).toContain('"Enabled"\n');
      expect(csv).toContain('"Disabled"\n');
    },
  );

  it("keeps the supported page and CSV in display-name order", () => {
    const directory = temporaryIndex();
    const names = ["scaffolder-backend-module-foo", "foo-backend", "foo", "bar"];
    addIndex(
      directory,
      Object.fromEntries(
        names.map((name) => [`org-${name}`, indexEntry(`org-${name}`, "generally-available")]),
      ),
    );
    for (const name of names) {
      addPackage(directory, `org-${name}`, {
        support: "generally-available",
        role: name === "foo" || name === "bar" ? "frontend-plugin" : "backend-plugin",
      });
    }
    addDefaults(directory, names, []);

    const outputs = renderTables("supported", directory);
    const expected = [
      "@org/bar",
      "@org/foo",
      "@org/foo-backend",
      "@org/scaffolder-backend-module-foo",
    ];
    for (const filename of ["ref-ga-plugins.adoc", "rhdh-supported-plugins.csv"]) {
      const positions = expected.map((name) =>
        outputs[filename]!.indexOf(filename.endsWith(".csv") ? `"${name}"` : `package/${name}/v/`),
      );
      expect(positions).not.toContain(-1);
      expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    }
  });

  it("rejects an index and entity with different OCI references", () => {
    const directory = temporaryIndex();
    addIndex(directory, { "org-foo": indexEntry("org-foo", "community") });
    addPackage(directory, "org-foo", {
      support: "community",
      reference: "oci://ghcr.io/org/org-foo@sha256:wrong",
    });
    expect(() => renderTables("community", directory)).toThrow(/OCI references differ/);
  });

  it("rejects an indexed package without a Package entity", () => {
    const directory = temporaryIndex();
    addIndex(directory, { "org-foo": indexEntry("org-foo", "community") });
    expect(() => renderTables("community", directory)).toThrow(/no Package entity/);
  });

  it("rejects an index file symlink that escapes the selected catalog", () => {
    const directory = temporaryIndex();
    const outside = temporaryIndex();
    addIndex(outside, {});
    symlinkSync(join(outside, "index.json"), join(directory, "index.json"));
    expect(() => renderTables("community", directory)).toThrow(/Catalog index must resolve inside/);
  });

  it("renders an explicit empty community page and a header-only CSV", () => {
    const directory = temporaryIndex();
    addIndex(directory, {});
    const outputs = renderTables("community", directory);
    expect(outputs["ref-community-supported-plugins.adoc"]).toContain(
      "There are no community supported plugins",
    );
    expect(outputs["ref-community-supported-plugins.adoc"]).not.toContain(
      "%%COMMUNITY_TABLE_CONTENT%%",
    );
    expect(outputs["rhdh-community-plugins.csv"]).toBe(
      CSV_COLUMNS.map((name) => `"${name}"`).join(",") + "\n",
    );
  });

  it("uses a downstream defaults file outside the catalog index", () => {
    const directory = temporaryIndex();
    const defaults = join(directory, "product-defaults.yaml");
    addIndex(directory, { "org-ga": indexEntry("org-ga", "generally-available") });
    addPackage(directory, "org-ga", { support: "generally-available" });
    writeFileSync(
      defaults,
      stringifyYaml({ packages: { enabled: [{ package: "@org/ga" }], disabled: [] } }),
    );

    const outputs = renderTables("supported", directory, defaults);
    expect(outputs["rhdh-supported-plugins.csv"]).toContain(
      '"Ga","@org/ga","Frontend","1.2.3","Production"',
    );
    expect(outputs["con-preinstalled-dynamic-plugins.adoc"]).toContain("* `@org/ga`");
  });
});
