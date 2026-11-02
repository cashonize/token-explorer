import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  // Next.js flat configs: @next/next core-web-vitals plus eslint-plugin-react,
  // eslint-plugin-react-hooks, jsx-a11y and import; then typescript-eslint recommended.
  ...nextVitals,
  ...nextTs,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  // Our pinned eslint-plugin-react-hooks 7 recommended preset (incl. React-Compiler-derived
  // rules). eslint-config-next registers the same package; if the two ever resolve to
  // different copies, ESLint fails with "Cannot redefine plugin" instead of silently
  // configuring a version we didn't pin.
  reactHooks.configs.flat.recommended,
  {
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
      // Links come from untrusted registries; keep rel="noreferrer" on target="_blank" (Next turns this off).
      "react/jsx-no-target-blank": "error",
      // Considered, not enabled:
      // - react/no-array-index-key: every list here is static derived data (OP_RETURN pushes,
      //   diagnostics) where the index is the identity; the rule can't tell them from reorderable lists.
      // - react/jsx-no-leaked-render: without type-aware linting it flags every `cond && <X/>`,
      //   including booleans (61 hits).

      // --- Next.js ships these as warnings; make them errors so CI lint is meaningful ---
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      "import/no-anonymous-default-export": "error",
      "jsx-a11y/alt-text": ["error", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
    },
  },
  {
    // The token icon is an arbitrary remote URL from a BCMR registry. next/image would need a
    // wildcard remotePatterns and would proxy any host through the Next image optimizer.
    files: ["src/components/MetadataDisplay.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  // Flat config doesn't read .gitignore and root-anchors patterns, so match build output at any
  // depth and skip .claude/ (local agent worktrees contain full checkouts with .next/ builds).
  globalIgnores([
    ".claude/**",
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/coverage/**",
    "next-env.d.ts",
  ]),
]);
