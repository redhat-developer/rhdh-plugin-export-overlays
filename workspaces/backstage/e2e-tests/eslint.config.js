import { createEslintConfig } from "@red-hat-developer-hub/e2e-test-utils/eslint";

export default [
  ...createEslintConfig(import.meta.dirname),
  {
    // Informational test diagnostics (resource IDs, retry notes) should not use warn.
    files: [
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/tests/**/*.ts",
      "**/e2e/**/*.ts",
    ],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    // pollUntil / pollUntilDefined wrap expect.poll; the plugin does not see expect inside helpers.
    files: [
      "**/github-scaffolder-actions.spec.ts",
      "**/gitlab-scaffolder-actions.spec.ts",
    ],
    rules: {
      "playwright/expect-expect": [
        "warn",
        {
          assertFunctionNames: ["pollUntil", "pollUntilDefined"],
        },
      ],
    },
  },
];
