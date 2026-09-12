// ESLint flat config for the Session Analyzer plugin.
//
// The project-specific trap linter (scripts/lint-plugin.mjs) catches the
// failure modes the normal toolchain can't see. This config catches the
// generic ones: unused variables, undefined globals, hook-rule violations.
// The plugin runs in the Hermes desktop renderer — browser globals plus the
// plugin-sdk surface the file imports.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "scripts/fixtures/", "pnpm-lock.yaml"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Node globals used by scripts/ and tests.
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // plugin.js is plain ESM with jsx()/jsxs() calls — prettier owns style,
      // so keep only correctness rules here.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // The drag-resize divider mutates document.body.style during a native
      // pointer gesture — DOM state, not React state, restored in pointerup.
      "react-hooks/immutability": "off",
    },
  },
];
