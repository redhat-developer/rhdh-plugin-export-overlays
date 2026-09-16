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
 *   <scope> <javascript-regex>
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
import { requireContained } from "./paths";
import { errorMessage } from "./util";

export type ExclusionScope = "install" | "boot";

// Module-private: the scope vocabulary is enforced through parseExclusions' errors,
// not consumed directly by callers.
const EXCLUSION_SCOPES: readonly ExclusionScope[] = ["install", "boot"];

export type Exclusion = {
  scope: ExclusionScope;
  /** Matched against the npm package name. */
  pattern: RegExp;
  /** Tracking ticket from the entry's `TODO(...)`, e.g. `RHIDP-16017`. */
  ticket: string;
  /** The regex exactly as written in the file, for reporting. */
  patternSource: string;
  /** 1-based line number in the exclusions file, for parse errors. */
  line: number;
};

/** What a matched exclusion records in results.json. */
export type ExclusionRecord = {
  packageName: string;
  scope: ExclusionScope;
  ticket: string;
  /** The regex exactly as written in the file — a string, unlike Exclusion.pattern. */
  patternSource: string;
};

// A ticket reference inside a comment, e.g. `# TODO(RHIDP-16017): reason`.
// One or more ticket keys, comma- or space-separated: a single exclusion can genuinely
// be blocked by two Jiras.
const TICKET_COMMENT =
  /^#\s*TODO\(([A-Z][A-Z0-9]+-\d+(?:[,\s]+[A-Z][A-Z0-9]+-\d+)*)\)/;
// Any TODO marker, well-formed keys or not — used to warn about the malformed ones
// rather than let them fall through to the previous block's ticket.
const TODO_COMMENT = /^#\s*TODO\(/;

function isExclusionScope(value: string): value is ExclusionScope {
  return (EXCLUSION_SCOPES as readonly string[]).includes(value);
}

/**
 * Parse an exclusions file. Throws on the first malformed entry — a silently
 * dropped exclusion would either fail the sweep on a package that is known-broken,
 * or (worse) skip a package nobody meant to skip.
 */
export function parseExclusions(text: string, filePath: string): Exclusion[] {
  const exclusions: Exclusion[] = [];
  // The ticket set by the most recent `TODO(...)` comment. A blank line ends the
  // block and clears it, so consecutive patterns may share one ticket (RHDH's file
  // does exactly that for its three unpublished refs) while a stray pattern after a
  // blank line cannot inherit a ticket it has nothing to do with.
  let ticket: string | undefined;

  for (const [index, raw] of text.split("\n").entries()) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      ticket = undefined;
    } else if (trimmed.startsWith("#")) {
      const matched = TICKET_COMMENT.exec(trimmed)?.[1];
      // A line that means to open a block but mistypes the key (`X-1`, `RHIDP16018`)
      // would otherwise leave the previous block's ticket in place, silently filing the
      // entries below it under an unrelated ticket — and they would then be deleted
      // when that ticket closes. Refuse it instead.
      if (!matched && TODO_COMMENT.test(trimmed)) {
        // Warn, don't throw. This runs in the plan job before anything is pulled, so
        // throwing meant a typo in a comment took down the whole scheduled sweep. The
        // ticket is cleared instead, and any pattern below it then fails with the far
        // clearer "has no tracking ticket" error — while a doc line with no pattern
        // under it stays harmless.
        console.warn(
          `⚠ ${filePath}:${index + 1}: '${trimmed}' looks like a TODO marker but has ` +
            `no well-formed ticket key (expected e.g. TODO(RHIDP-1234)) — ignored.`,
        );
        ticket = undefined;
      } else {
        ticket = matched ?? ticket;
      }
    } else {
      exclusions.push(parseEntry(trimmed, ticket, filePath, index + 1));
    }
  }

  return exclusions;
}

/** Parse one `<scope> <regex>` line. Throws with file:line on anything malformed. */
function parseEntry(
  trimmed: string,
  ticket: string | undefined,
  filePath: string,
  line: number,
): Exclusion {
  const [scope, ...rest] = trimmed.split(/\s+/);
  if (!isExclusionScope(scope)) {
    throw new Error(
      `${filePath}:${line}: unknown scope '${scope}' — expected one of ${EXCLUSION_SCOPES.join(", ")}`,
    );
  }
  if (rest.length !== 1) {
    throw new Error(
      `${filePath}:${line}: expected '<scope> <regex>', got '${trimmed}'`,
    );
  }
  if (!ticket) {
    throw new Error(
      `${filePath}:${line}: '${trimmed}' has no tracking ticket — precede it with ` +
        `'# TODO(TICKET-123): <why, and what unblocks it>'. Exclusions without a ` +
        `ticket never get removed.`,
    );
  }
  const [pattern] = rest;
  try {
    return {
      scope,
      pattern: new RegExp(pattern),
      ticket,
      patternSource: pattern,
      line,
    };
  } catch (err) {
    throw new Error(
      `${filePath}:${line}: invalid regex '${pattern}': ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

/**
 * Read and parse an exclusions file. The path reaches here from a CLI flag, so it is
 * contained to the working directory before the read (Sonar S8707) — callers validate
 * too, but this is the function that actually touches the filesystem.
 */
export function loadExclusions(path: string): Exclusion[] {
  const contained = requireContained("--exclusions", path);
  return parseExclusions(readFileSync(contained, "utf8"), path);
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
 *
 * The OCI IMAGE NAME is a third spelling of the same plugin, and catalog-index mode has
 * nothing else to offer: an index carries `oci://…/backstage-community-plugin-quay@sha256:…`
 * and no npm name anywhere. Emitting the image form here is what lets ONE pattern in
 * catalog-index-sanity-excludes.txt hold at install scope (matched against the image
 * name read off the index) and at boot scope (matched against the installed
 * package.json's npm name) — the same one-identifier-space guarantee the -dynamic
 * normalization gives workspace mode.
 */
export function candidateNames(packageName: string): string[] {
  const base = packageName.replace(/-dynamic$/, "");
  // Both directions. Stripping only the NAME meant a pattern written with the suffix
  // matched at boot scope (installed name) but not at install scope (metadata name) —
  // the very "matches at one scope and not the other" failure this normalization is
  // here to prevent.
  // `packageName` is already one of these two: it either ends in -dynamic (so it
  // equals the second) or it does not (so it equals the first).
  const npm = [base, `${base}-dynamic`];
  // `@scope/name` -> `scope-name`, the transform the export tooling uses to name the
  // published image. A name that is already in image form passes through unchanged, so
  // this only ever ADDS candidates and never removes an npm-form match.
  const image = base.replace(/^@/, "").replaceAll("/", "-");
  return [...new Set([...npm, image, `${image}-dynamic`])];
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
      ? {
          packageName,
          scope,
          ticket: hit.ticket,
          patternSource: hit.patternSource,
        }
      : undefined;
  };
}
