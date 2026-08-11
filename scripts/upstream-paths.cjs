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

// Resolve one source-relative path to its real path in the source repo, the same
// way Codecov matches a report path against a git tree.
//
// Ambiguity is dropped rather than guessed: several plugins in one workspace
// legitimately share `src/index.ts`, and attributing one plugin's coverage to
// another is a worse outcome than losing the file. In practice the dropped files
// are wiring (index, plugin, alpha) that the source repo's own codecov.yml
// already ignores.
function resolveUpstream(index, sourcePath) {
  const suffix = `/${sourcePath}`;
  const hits = index.filter((f) => f.endsWith(suffix));
  if (hits.length === 1) return { path: hits[0], reason: null };
  return { path: null, reason: hits.length > 1 ? "ambiguous" : "not-in-tree" };
}

module.exports = { indexUpstreamTree, resolveUpstream };
