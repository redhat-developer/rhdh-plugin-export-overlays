//
// Resolve a plugin's source-relative paths (`src/utils/foo.ts`) onto the real
// repo-relative paths of the repository the sources live in.
//
// Split out of remap-coverage.cjs so this logic can be tested on its own: the
// rest of that script needs the istanbul libraries, which remap-lcov.sh installs
// into a throwaway prefix at run time, and requiring a network install to
// exercise a pure path lookup would mean it never gets exercised. Everything
// here depends only on node builtins, and nothing here writes to the console —
// callers decide how to report what these functions hand back.
//
// See scripts/tests/test_upstream_paths.py.

const fs = require("node:fs");
const path = require("node:path");

// Every file the source repo tracks under this workspace, as repo-relative
// paths. `.git` and `node_modules` are skipped: a fresh shallow clone has
// neither, but a reused working tree would otherwise drown the index in
// dependencies whose names collide with real sources.
function listUpstreamFiles(root, workspace) {
  const base = path.join(root, "workspaces", workspace);
  if (!fs.existsSync(base)) {
    const err = new Error(
      `no 'workspaces/${workspace}' in the upstream checkout at ${root} — ` +
        "wrong repo, or the pinned ref predates the workspace.",
    );
    err.code = "ENOWORKSPACE";
    throw err;
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(root, full));
    }
  };
  walk(base);
  return found;
}

// Every webpack remote a plugin can publish under. A plugin reaches the browser
// through one of two builds, and they name the remote differently:
//
//   Scalprum uses the name as written — explicit `scalprum.name`, or
//     `<scope>.<name>` derived from the package.
//   Module Federation needs a valid JS identifier, so it sanitises: `@`
//     dropped, `/` -> `__`, `-` -> `_`.
//
// Which one a given plugin serves through is not visible from a manifest —
// app-defaults and adoption-insights differ with identical-looking manifests —
// so both are claimed. scripts/generate-coverage-anchors.sh writes an anchor for
// the same pair; change the two together.
//
// The declared name is returned first and marked, because a declared claim
// outranks a derived one when two plugins want the same remote.
function remotesOf(pkg) {
  const out = [];
  const add = (remote, declared) => {
    // An unscoped, hyphen-free name derives to itself both ways (`foo`).
    // Pushing it twice would read downstream as two plugins claiming one
    // remote, and cost the plugin the tie-break it should have had.
    if (!out.some((r) => r.remote === remote)) out.push({ remote, declared });
  };

  // Validated once: a non-string `scalprum.name` is not a claim, and must not
  // suppress the derived form either.
  const raw = pkg?.scalprum?.name;
  const declared = typeof raw === "string" && raw ? raw : null;
  if (declared) add(declared, true);

  if (typeof pkg?.name === "string" && pkg.name) {
    const bare = pkg.name.replace(/^@/, "");
    if (!declared) add(bare.replace(/\//g, "."), false);
    add(bare.replace(/\//g, "__").replace(/-/g, "_"), false);
  }
  return out;
}

// Map each plugin's webpack remote to the directory that owns it, so an
// ambiguous path can be attributed to the plugin the coverage came from.
//
// Returns `{ pluginDirs, collisions, unreadable }`. The two problem lists are
// returned rather than logged: this module has no opinion on how a caller
// reports them, and a returned value is assertable where captured stderr is not.
//
// Only `workspaces/<ws>/plugins/<dir>` is scanned. Every workspace in the one
// upstream-eligible repo is laid out that way; a repo that nests plugins deeper
// gets no tie-break rather than a wrong one.
function mapPluginDirsByRemote(root, workspace) {
  const pluginsDir = path.join(root, "workspaces", workspace, "plugins");
  const pluginDirs = new Map();
  const collisions = [];
  const unreadable = [];
  if (!fs.existsSync(pluginsDir)) return { pluginDirs, collisions, unreadable };

  // Declared names claim first, so a derived name can never displace one a
  // plugin asked for — or collide with it and take both down.
  const claims = { declared: new Map(), derived: new Map() };
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    } catch {
      // Costs this plugin its tie-break, not the run — but the caller is told,
      // so the resulting drops are not mistaken for ordinary wiring noise.
      unreadable.push(path.relative(root, manifest));
      continue;
    }

    for (const found of remotesOf(pkg)) {
      const bucket = found.declared ? claims.declared : claims.derived;
      if (!bucket.has(found.remote)) bucket.set(found.remote, []);
      // Built with path.relative so it is the same shape as listUpstreamFiles'
      // entries; the two are compared directly in resolveUpstreamPath.
      bucket.get(found.remote).push(path.relative(root, dir));
    }
  }

  for (const bucket of [claims.declared, claims.derived]) {
    for (const [remote, dirs] of bucket) {
      if (pluginDirs.has(remote)) continue; // a declared claim already won
      if (dirs.length > 1) {
        // Keeping one would be a coin flip on readdir order, and a wrong owner
        // attributes one plugin's coverage to another's file. Refuse: those
        // paths fall back to being reported ambiguous, which is honest.
        collisions.push({ remote, dirs });
        continue;
      }
      pluginDirs.set(remote, dirs[0]);
    }
  }
  return { pluginDirs, collisions, unreadable };
}

// Everything under `dir`, plus `dir` itself, as a prefix test.
function isAtOrAbove(candidate, dir) {
  return dir === candidate || dir.startsWith(`${candidate}/`);
}

// Resolve one source-relative path to its real path in the source repo, the same
// way Codecov matches a report path against a git tree.
//
// `ownerDir` is the directory of the plugin the coverage came from. It is not
// only a tie-break: a single match is accepted only when it is one the owner
// could legitimately produce, which is either its own copy or a path that named
// the package it lives in (`<pkg>-common/src/x.ts`, a sibling import). A bare
// `src/x.ts` that resolves into a sibling means the owner does not ship that
// file at this ref — taking it would write one plugin's coverage onto another
// plugin's file, silently and with real line numbers.
//
// Reasons for a miss are distinguished because they call for different actions:
// `not-in-tree` points at the pinned ref, `not-in-owner` at the ref or a moved
// file, `ambiguous` at plugins sharing a name with no owner to settle it.
function resolveUpstreamPath(files, sourcePath, ownerDir) {
  const suffix = `/${sourcePath}`;
  const hits = files.filter((f) => f.endsWith(suffix));
  // Tolerated because ownerDir crosses a module boundary and a trailing
  // separator is an easy thing for a caller to hand over.
  const owner = ownerDir ? ownerDir.replace(/\/+$/, "") : null;

  if (hits.length === 1) {
    const hit = hits[0];
    if (!owner) return { upstreamPath: hit, reason: null };
    // What the hit sits under, once the matched tail is removed.
    const container = hit.slice(0, hit.length - suffix.length);
    return isAtOrAbove(container, owner)
      ? { upstreamPath: hit, reason: null }
      : { upstreamPath: null, reason: "not-in-owner" };
  }

  if (hits.length > 1 && owner) {
    const owned = hits.filter((f) => f.startsWith(`${owner}/`));
    // Exactly one: two copies inside the owner is still a guess.
    if (owned.length === 1) return { upstreamPath: owned[0], reason: null };
  }

  return {
    upstreamPath: null,
    reason: hits.length > 1 ? "ambiguous" : "not-in-tree",
  };
}

module.exports = { listUpstreamFiles, mapPluginDirsByRemote, resolveUpstreamPath };
