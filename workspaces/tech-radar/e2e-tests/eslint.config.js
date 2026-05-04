import { createEslintConfig } from "@red-hat-developer-hub/e2e-test-utils/eslint";

export default [
  ...createEslintConfig(import.meta.dirname),
  {
    files: ["**/*.spec.ts"],
    rules: {
      "playwright/expect-expect": [
        "warn",
        { assertFunctionNames: ["verifyRadarDetails"] },
      ],
    },
  },
];
