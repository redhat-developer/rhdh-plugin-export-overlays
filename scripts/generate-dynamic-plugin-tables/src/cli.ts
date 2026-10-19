#!/usr/bin/env node
/*
 * Copyright (c) Red Hat, Inc.
 * SPDX-License-Identifier: EPL-2.0
 */

/** Render one tier's docs files from its resolved catalog index. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DOCS_DIR, renderTables } from "./generate.ts";

const USAGE = `Usage: generate-dynamic-plugin-tables --tier supported|community --index-dir DIR
       [--output-dir DIR] [--default-packages-file FILE]

Generate AsciiDoc plugin tables and CSV inventories from a resolved catalog index.
Supported mode also reads INDEX_DIR/default.packages.yaml unless overridden.`;

function main(args: string[]): number {
  try {
    const { values } = parseArgs({
      args,
      options: {
        tier: { type: "string" },
        "index-dir": { type: "string" },
        "output-dir": { type: "string" },
        "default-packages-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    const tier = values.tier;
    if (tier !== "supported" && tier !== "community") {
      throw new Error("--tier must be supported or community");
    }
    const indexDir = values["index-dir"];
    if (!indexDir) throw new Error("--index-dir is required");

    const outputs = renderTables(tier, indexDir, values["default-packages-file"]);
    const outputDir = values["output-dir"] ?? join(indexDir, DOCS_DIR);
    mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of Object.entries(outputs)) {
      writeFileSync(join(outputDir, name), content, "utf8");
    }
    console.log(
      `Generated ${Object.keys(outputs).length} ${tier} documentation files in ${outputDir}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `Error generating plugin tables: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
