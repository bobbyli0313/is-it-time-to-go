import coreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * ESLint 9 flat config.
 *
 * `eslint-config-next` v16 ships flat configs natively, so the old
 * `FlatCompat` + `extends: ["next/core-web-vitals"]` dance is unnecessary —
 * and in fact breaks, because FlatCompat tries to JSON-serialise a config graph
 * containing circular plugin references.
 */
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
];

export default eslintConfig;
