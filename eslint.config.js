import js from "@eslint/js";
import tseslint from "typescript-eslint";
import checkFile from "eslint-plugin-check-file";
import playwright from "eslint-plugin-playwright";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // TypeScript naming conventions for test files
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "variable",
          format: ["camelCase", "PascalCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "variable",
          modifiers: ["const"],
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
        },
        {
          selector: "function",
          format: ["camelCase", "PascalCase"],
        },
        {
          selector: "parameter",
          format: ["camelCase", "PascalCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "typeLike",
          format: ["PascalCase"],
        },
        {
          selector: "enumMember",
          format: ["PascalCase"],
        },
      ],
      // Promise handling
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Allow any type in tests (for mocking, test data)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars starting with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // Allow empty functions (for test stubs)
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    files: ["**/*.{js,ts}"],
    plugins: {
      "check-file": checkFile,
    },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        {
          "**/*.{js,ts}": "KEBAB_CASE",
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],
      "check-file/folder-naming-convention": [
        "error",
        {
          "**": "KEBAB_CASE",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "blob-report/**",
      ".github/**",
      "*.config.js",
      "*.config.ts",
      "workspaces/**",
      "!workspaces/**/e2e-tests/**",
      "e2e-test-utils/run-plugin-tests.js",
    ],
  },
  // Playwright test files
  {
    ...playwright.configs["flat/recommended"],
    files: [
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/tests/**/*.ts",
      "**/e2e/**/*.ts",
    ],
    rules: {
      ...playwright.configs["flat/recommended"].rules,
      // Playwright best practices
      "playwright/expect-expect": "warn",
      "playwright/max-nested-describe": ["warn", { max: 2 }],
      "playwright/missing-playwright-await": "error",
      "playwright/no-conditional-in-test": "warn",
      "playwright/no-element-handle": "warn",
      "playwright/no-eval": "error",
      "playwright/no-focused-test": "error",
      "playwright/no-force-option": "warn",
      "playwright/no-page-pause": "warn",
      "playwright/no-skipped-test": [
        "warn",
        {
          allowConditional: true,
        },
      ],
      "playwright/no-useless-await": "warn",
      "playwright/no-useless-not": "warn",
      "playwright/no-wait-for-selector": "warn",
      "playwright/no-wait-for-timeout": "warn",
      "playwright/prefer-web-first-assertions": "error",
      "playwright/require-top-level-describe": "off",
      "playwright/valid-describe-callback": "off",
      "playwright/valid-expect": "error",
      "playwright/valid-title": "warn",
      // Custom restrictions
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='fixme'][callee.object.property.name='describe'][callee.object.object.name='test']",
          message:
            "test.describe.fixme() is not valid. Use test.fixme() on individual tests instead.",
        },
      ],
      // Disallow console.log in tests (use test.info() instead)
      "no-console": [
        "warn",
        {
          allow: ["warn", "error"],
        },
      ],
    },
  },
  // Page Object Models and utilities
  {
    files: [
      "**/page-objects/**/*.ts",
      "**/utils/**/*.ts",
      "**/helpers/**/*.ts",
    ],
    rules: {
      // Allow class-based page objects
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "class",
          format: ["PascalCase"],
          suffix: ["Page", "Component", "Helper", "Util"],
        },
        {
          selector: "memberLike",
          modifiers: ["private"],
          format: ["camelCase"],
          leadingUnderscore: "require",
        },
        {
          selector: "memberLike",
          modifiers: ["public"],
          format: ["camelCase"],
        },
      ],
    },
  },
  // Fixtures
  {
    files: ["**/fixtures/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Config files
  {
    files: ["playwright.config.ts", "*.config.ts"],
    rules: {
      "@typescript-eslint/naming-convention": "off",
      "check-file/filename-naming-convention": "off",
    },
  },
];
