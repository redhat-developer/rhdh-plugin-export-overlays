/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Tracked exclusions for the sweep, following the discipline of RHDH PR #4967's
 * `e2e-tests/local-harness/plugin-sanity-excludes.txt`: every excluded package
 * carries a `TODO(TICKET)` so exclusions get removed rather than accumulated.
 * A pattern with no ticket in scope is a parse error, not a warning — that is the
 * whole enforcement mechanism.
 *
 * Format (one entry per line, `#` comments, blank line ends a block):
 *
 *   # TODO(RHIDP-1234): why this package cannot be validated, and what unblocks it.
 *   <scope> <extended-regex>
 *
 * `scope` says how much validation the package loses, because the two failure modes
 * are genuinely different and conflating them would throw away real coverage:
 *
 *   install — the artifact is not pulled at all (cannot be pulled anonymously, or
 *             installing it breaks the whole run). Loses everything.
 *   boot    — the artifact IS pulled and its layout validated, but the plugin is not
 *             loaded into `startTestBackend`. Loses only the boot signal. This is
 *             what the catalog-extending modules need: the catalog core does not boot
 *             standalone, but their published artifacts are still worth validating.
 *
 * The regex is matched against the npm PACKAGE NAME (`spec.packageName` in metadata,
 * `name` in the installed package.json) — one identifier space for both scopes.
 * RHDH's file matches OCI refs because the catalog index is all it has; here the
 * metadata carries the package name, which is stable across tag and digest refs.
 */

import { readFileSync } from "node:fs";

export type ExclusionScope = "install" | "boot";

export const EXCLUSION_SCOPES: readonly ExclusionScope[] = ["install", "boot"];

export type Exclusion = {
  scope: ExclusionScope;
  /** Matched against the npm package name. */
  pattern: RegExp;
  /** Tracking ticket from the entry's `TODO(...)`, e.g. `RHIDP-16017`. */
  ticket: string;
  /** Raw regex source, for reporting. */
  source: string;
  /** 1-based line number in the exclusions file, for parse errors. */
  line: number;
};

/** What a matched exclusion records in results.json. */
export type ExclusionRecord = {
  packageName: string;
  scope: ExclusionScope;
  ticket: string;
  pattern: string;
};

// A ticket reference inside a comment, e.g. `# TODO(RHIDP-16017): reason`.
const TICKET_COMMENT = /^#\s*TODO\(([A-Z][A-Z0-9]+-\d+)\)/;

function isExclusionScope(value: string): value is ExclusionScope {
  return (EXCLUSION_SCOPES as readonly string[]).includes(value);
}

/**
 * Parse an exclusions file. Throws on the first malformed entry — a silently
 * dropped exclusion would either fail the sweep on a package that is known-broken,
 * or (worse) skip a package nobody meant to skip.
 */
export function parseExclusions(text: string, source: string): Exclusion[] {
  const exclusions: Exclusion[] = [];
  // The ticket set by the most recent `TODO(...)` comment. A blank line ends the
  // block and clears it, so consecutive patterns may share one ticket (RHDH's file
  // does exactly that for its three unpublished refs) while a stray pattern after a
  // blank line cannot inherit a ticket it has nothing to do with.
  let ticket: string | undefined;
  const lines = text.split("\n");

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") {
      ticket = undefined;
      continue;
    }
    if (trimmed.startsWith("#")) {
      const match = TICKET_COMMENT.exec(trimmed);
      if (match) ticket = match[1];
      continue;
    }

    const [scope, ...rest] = trimmed.split(/\s+/);
    if (!isExclusionScope(scope)) {
      throw new Error(
        `${source}:${line}: unknown scope '${scope}' — expected one of ${EXCLUSION_SCOPES.join(", ")}`,
      );
    }
    if (rest.length !== 1) {
      throw new Error(
        `${source}:${line}: expected '<scope> <regex>', got '${trimmed}'`,
      );
    }
    if (!ticket) {
      throw new Error(
        `${source}:${line}: '${trimmed}' has no tracking ticket — precede it with ` +
          `'# TODO(TICKET-123): <why, and what unblocks it>'. Exclusions without a ` +
          `ticket never get removed.`,
      );
    }
    const [pattern] = rest;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      throw new Error(
        `${source}:${line}: invalid regex '${pattern}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    exclusions.push({ scope, pattern: regex, ticket, source: pattern, line });
  }

  return exclusions;
}

export function loadExclusions(path: string): Exclusion[] {
  return parseExclusions(readFileSync(path, "utf8"), path);
}

/**
 * The names a pattern is tested against.
 *
 * The dynamic export appends `-dynamic` to the package name, so the same plugin is
 * `@backstage-community/plugin-quay` in metadata and
 * `@backstage-community/plugin-quay-dynamic` in the installed package.json. Matching
 * the suffixed form too keeps one pattern valid at both `install` scope (resolved
 * from metadata) and `boot` scope (resolved from the install root) — otherwise an
 * anchored pattern silently matches at one scope and not the other.
 */
function candidateNames(packageName: string): string[] {
  const base = packageName.replace(/-dynamic$/, "");
  return base === packageName ? [packageName] : [packageName, base];
}

/** First exclusion of `scope` matching the package name, if any. */
export function matchExclusion(
  exclusions: Exclusion[],
  scope: ExclusionScope,
  packageName: string,
): Exclusion | undefined {
  const candidates = candidateNames(packageName);
  return exclusions.find(
    (e) => e.scope === scope && candidates.some((name) => e.pattern.test(name)),
  );
}

/** Curry `matchExclusion` into the `packageName -> record?` shape consumers want. */
export function excluderFor(
  exclusions: Exclusion[],
  scope: ExclusionScope,
): (packageName: string) => ExclusionRecord | undefined {
  return (packageName) => {
    const hit = matchExclusion(exclusions, scope, packageName);
    return hit
      ? { packageName, scope, ticket: hit.ticket, pattern: hit.source }
      : undefined;
  };
}
