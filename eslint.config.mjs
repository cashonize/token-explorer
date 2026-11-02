import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default defineConfig([
  // ESLint + typescript-eslint recommended, eslint-plugin-react recommended (new JSX transform),
  // and Vite's react-refresh preset (only-export-components, so Fast Refresh keeps state).
  js.configs.recommended,
  tseslint.configs.recommended,
  // Type-aware rules, TS files only (they need type information; eslint.config.mjs has none).
  // projectService resolves each file through tsconfig.json's references: src/ via
  // tsconfig.app.json, vite.config.ts and *.test.ts(x) via tsconfig.node.json.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Un-awaited promises must be handled: `await`, `.catch(...)`, or `void` plus a comment
      // saying where the rejection is caught.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactRefresh.configs.vite,
  {
    languageOptions: { globals: globals.browser },
    settings: { react: { version: "detect" } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  // Our pinned eslint-plugin-react-hooks 7 recommended preset (incl. React-Compiler-derived rules).
  reactHooks.configs.flat.recommended,
  {
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      // --- react-hooks ---
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error", // preset ships this as a warning
      // Only reports libraries the React Compiler can't memoize; we don't run the compiler.
      "react-hooks/incompatible-library": "off",
      "react-hooks/unsupported-syntax": "error", // eval/with; preset ships a warning

      // --- eslint-plugin-react: a few bug-catching rules on top of its recommended set ---
      // Also flag keyless <>...</> fragments in lists and duplicate literal keys.
      "react/jsx-key": ["error", { checkFragmentShorthand: true, warnOnDuplicates: true }],
      // Components defined inside components remount (and lose state) on every render.
      "react/no-unstable-nested-components": "error",
      // We render untrusted registry metadata; raw HTML injection must be explicit and justified.
      "react/no-danger": "error",
      // Links come from untrusted registries; keep rel="noreferrer" on target="_blank".
      "react/jsx-no-target-blank": "error",
      // Considered, not enabled:
      // - react/no-array-index-key: every list here is static derived data (OP_RETURN pushes,
      //   diagnostics) where the index is the identity; the rule can't tell them from reorderable lists.
      // - react/jsx-no-leaked-render: without type-aware linting it flags every `cond && <X/>`,
      //   including booleans (61 hits).

      // --- the recommended presets ship these as warnings; make them errors so CI lint is meaningful ---
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      // The jsx-a11y rules eslint-config-next enabled (before the move to Vite), kept as errors.
      "jsx-a11y/alt-text": ["error", { elements: ["img"] }],
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      // Not carried over from eslint-config-next: import/no-anonymous-default-export (it needs
      // eslint-plugin-import; react-refresh/only-export-components already rejects anonymous
      // component exports, which were the only case that rule mattered for here).
    },
  },
  {
    // Build tooling runs in Node
    files: ["vite.config.ts", "eslint.config.mjs"],
    languageOptions: { globals: globals.node },
  },
  // Flat config doesn't read .gitignore and root-anchors patterns, so match build output at any
  // depth and skip .claude/ (local agent worktrees contain full checkouts with dist/ builds).
  globalIgnores([
    ".claude/**",
    "**/dist/**",
    "**/coverage/**",
  ]),
]);
