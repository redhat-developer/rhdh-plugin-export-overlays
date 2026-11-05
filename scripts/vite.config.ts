import { defineConfig } from "vite-plus";

// Ignore every root-level file (legacy Python / shell / CJS tools), then
// re-include directories (workspace packages) and the root meta files we want
// vp check to own. `*.ext` without a slash would also match inside packages.
const rootIgnore = [
  "/*",
  "!/*/",
  "!/package.json",
  "!/README.md",
  "!/vite.config.ts",
  "!/AGENTS.md",
  "tests/**",
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
});
