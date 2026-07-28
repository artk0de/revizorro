import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Ported from tea-rags (bug-history-calibrated ruleset). The tea-rags
// dependency-direction import matrix is intentionally dropped — it references
// tea-rags-specific src/core/domains paths that don't exist here.
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      // Async/Promise
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/promise-function-async": "warn",
      "@typescript-eslint/require-await": "off",
      "require-atomic-updates": "off",

      // Type safety
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/consistent-type-exports": [
        "error",
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/prefer-readonly": "warn",

      // Logic errors
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
      "no-constant-condition": "error",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",

      // Unused code
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-unreachable": "error",
      "@typescript-eslint/no-unused-expressions": "error",

      // Quality & best practices
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/prefer-as-const": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/array-type": ["error", { default: "array" }],
      "@typescript-eslint/method-signature-style": ["error", "property"],
      "@typescript-eslint/unbound-method": "warn",
      "no-console": "off",

      // Error handling
      "@typescript-eslint/only-throw-error": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",

      // Return types
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-confusing-void-expression": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",

      // ESLint core best practices
      "no-eval": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "no-new-func": "error",
      "no-param-reassign": "warn",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-template-curly-in-string": "warn",
      "no-unmodified-loop-condition": "error",
      "no-useless-concat": "error",
      "prefer-template": "warn",
      "no-else-return": "warn",
      "no-lonely-if": "warn",
      "no-useless-return": "error",
      "object-shorthand": ["warn", "always"],
      "prefer-const": "error",
      "prefer-destructuring": ["warn", { object: true, array: false }],
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "symbol-description": "error",
      curly: ["error", "multi-line"],
    },
  },

  // Webview runs in the browser (DOM globals, not node)
  {
    files: ["packages/extension/media/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },

  // Tests: relax strict type-safety rules
  {
    files: ["**/*.test.ts", "**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-param-reassign": "off",
      "@typescript-eslint/prefer-readonly": "off",
    },
  },

  // Plain JS / mjs (bin, scripts, root configs) — outside tsconfig, so no type
  // info: type-aware rules would fail to parse them rather than check them.
  {
    files: ["packages/*/bin/**/*.js", "scripts/**/*.mjs", "*.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "eslint.config.js",
      "vitest.config.ts",
      "packages/extension/media/webview.js",
      ".claude/**",
    ],
  },
);
