import { createEslintConfig } from "@red-hat-developer-hub/e2e-test-utils/eslint";

const baseConfig = createEslintConfig(import.meta.dirname);
// Ignore PnP and generated files
export default [
  { ignores: [".pnp.*", "**/.pnp.*", ".yarn/**"] },
  ...baseConfig,
];
