import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {FlatCompat} from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-config-next only ships legacy .eslintrc-shaped configs; FlatCompat bridges them into
// this flat config (the only format ESLint 9 loads by default).
const compat = new FlatCompat({baseDirectory: __dirname});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "protocol/**",
      ".next/**",
      ".next-e2e/**",
      ".next-e2e-dev/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  {
    // WP4.21V E2: every spec gets the external-host guard from e2e/fixtures.ts.
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": ["error", {paths: [{name: "@playwright/test", message: "Import test and expect from ./fixtures: it carries the external-host guard."}]}],
    },
  },
];

export default eslintConfig;
