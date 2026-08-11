//
// Resolve a plugin's source-relative paths (`src/utils/foo.ts`) onto the real
// repo-relative paths of the repository the sources live in.
//
// Split out of remap-coverage.cjs so this logic can be tested on its own: the
// rest of that script needs the istanbul libraries, which remap-lcov.sh installs
// into a throwaway prefix at run time, and requiring a network install to
// exercise a pure path lookup would mean it never gets exercised. Everything
// here depends only on node builtins.
//
// See scripts/tests/test_upstream_paths.py.

const fs = require("node:fs");
const path = require("node:path");

// Every file the source repo tracks under this workspace, as repo-relative
// paths. `.git` and `node_modules` are skipped: a fresh shallow clone has
// neither, but a reused working tree would otherwise drown the index in
// dependencies whose names collide with real sources.
function indexUpstreamTree(root, workspace) {
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

// Map each plugin's webpack remote (its scalprum name) to the plugin directory
// that owns it, so an ambiguous path can be attributed to the plugin the
// coverage actually came from.
//
// The remote is read from the plugin's own `scalprum.name` rather than derived
// from its package name. Both usually agree (`@scope/pkg` -> `scope.pkg`), but
// the declared value is authoritative and the derivation is only a fallback for
// a plugin that does not declare one. Deriving the other way — guessing a
// directory from the remote string — is what fails: it cannot recover a
// directory name that differs from the package name.
function mapPluginDirsByRemote(root, workspace) {
  const pluginsDir = path.join(root, "workspaces", workspace, "plugins");
  const byRemote = new Map();
  if (!fs.existsSync(pluginsDir)) return byRemote;

  const claimedBy = new Map();
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(pluginsDir, entry.name, "package.json");
    if (!fs.existsSync(manifest)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    } catch {
      // A malformed manifest costs this plugin its tie-breaking, not the run.
      continue;
    }
    const remote =
      pkg?.scalprum?.name ||
      (pkg?.name ? pkg.name.replace(/^@/, "").replace("/", ".") : null);
    if (!remote) continue;
    if (!claimedBy.has(remote)) claimedBy.set(remote, []);
    claimedBy.get(remote).push(`workspaces/${workspace}/plugins/${entry.name}`);
  }

  for (const [remote, dirs] of claimedBy) {
    if (dirs.length > 1) {
      // Keeping one would be a coin flip on readdir order, and the whole point
      // of the tie-break is to attribute to the plugin the coverage came from.
      // Dropping the entry costs those paths their tie-break — they fall back to
      // being reported ambiguous, which is the honest outcome — rather than
      // silently attributing one plugin's coverage to another's file.
      console.warn(
        `[remap] remote '${remote}' is claimed by ${dirs.length} plugins ` +
          `(${dirs.map((d) => d.split("/").pop()).join(", ")}) — no tie-break ` +
          "for it; check their package.json scalprum.name.",
      );
      continue;
    }
    byRemote.set(remote, dirs[0]);
  }
  return byRemote;
}

// Resolve one source-relative path to its real path in the source repo, the same
// way Codecov matches a report path against a git tree.
//
// A unique match across the workspace wins outright — that is what resolves a
// sibling package's file (`<pkg>-common/src/x.ts`), which lives outside the
// plugin the coverage came from.
//
// When several plugins in the workspace share the path — `src/index.ts` and
// `src/api/index.ts` are the common cases — `ownerDir` breaks the tie, because
// the coverage carries the remote of the plugin it came from and only that
// plugin's copy can be the right one. Without an owner the path is dropped
// rather than guessed: attributing one plugin's coverage to another is worse
// than losing the file.
function resolveUpstream(files, sourcePath, ownerDir) {
  const suffix = `/${sourcePath}`;
  const hits = files.filter((f) => f.endsWith(suffix));
  if (hits.length === 1) return { path: hits[0], reason: null };

  if (hits.length > 1 && ownerDir) {
    const owned = hits.filter((f) => f.startsWith(`${ownerDir}/`));
    if (owned.length === 1) return { path: owned[0], reason: null };
  }

  return { path: null, reason: hits.length > 1 ? "ambiguous" : "not-in-tree" };
}

module.exports = { indexUpstreamTree, mapPluginDirsByRemote, resolveUpstream };
