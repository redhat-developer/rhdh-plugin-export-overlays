#!/usr/bin/env node
/*
 * Copyright (c) Red Hat, Inc.
 * SPDX-License-Identifier: EPL-2.0
 */

/** Render one tier's docs files from its resolved catalog index. */

import { closeSync, constants, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DOCS_DIR, renderTables, requireContained } from "./generate.ts";

const USAGE = `Usage: generate-dynamic-plugin-tables --tier supported|community --index-dir DIR
       [--output-dir DIR] [--default-packages-file FILE] [--debug]

Generate AsciiDoc plugin tables and CSV inventories from a resolved catalog index.
Supported mode also reads INDEX_DIR/default.packages.yaml unless overridden.
All paths must resolve inside the current working directory.
--debug prints each row added to the generated tables and CSVs.`;

function main(args: string[]): number {
  try {
    const { values } = parseArgs({
      args,
      options: {
        tier: { type: "string" },
        "index-dir": { type: "string" },
        "output-dir": { type: "string" },
        "default-packages-file": { type: "string" },
        debug: { type: "boolean" },
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
    const requestedIndexDir = values["index-dir"];
    if (!requestedIndexDir) throw new Error("--index-dir is required");

    // The caller chooses paths, but none may escape the directory it invoked us from.
    const indexDir = requireContained("--index-dir", requestedIndexDir);
    const defaultsFile = values["default-packages-file"]
      ? requireContained("--default-packages-file", values["default-packages-file"])
      : undefined;
    const outputDir = requireContained(
      "--output-dir",
      values["output-dir"] ?? join(indexDir, DOCS_DIR),
    );

    const debug = values.debug ? (message: string) => console.log(`[DEBUG] ${message}`) : undefined;
    const outputs = renderTables(tier, indexDir, defaultsFile, debug);
    mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of Object.entries(outputs)) {
      const path = requireContained(`output file ${name}`, join(outputDir, name));
      // O_NOFOLLOW also rejects a dangling symlink, which realpath cannot resolve.
      const file = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        writeFileSync(file, content, "utf8");
      } finally {
        closeSync(file);
      }
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
