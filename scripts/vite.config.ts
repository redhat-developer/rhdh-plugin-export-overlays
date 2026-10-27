import { defineConfig } from "vite-plus";

// Ignore every root-level file (legacy Python / shell / CJS tools), then
// re-include directories (workspace packages) and the root meta files we want
// vp check to own. `*.ext` without a slash would also match inside packages.
const rootIgnore = [
  "/*",
  "!/*/",
  "!/package.json",
  "!/README.md",
  "!/tsconfig.json",
  "!/vite.config.ts",
  "!/AGENTS.md",
  "tests/**",
  "inject-dpdy-tag-comments/fixtures/**",
];

export default defineConfig({
  fmt: {
    ignorePatterns: rootIgnore,
  },
  lint: {
    ignorePatterns: rootIgnore,
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    coverage: {
      // Gate coverage on inject only until other workspace packages enforce it; then
      // delete this `include` so `vp test --coverage` measures the whole tree.
      include: ["inject-dpdy-tag-comments/src"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
