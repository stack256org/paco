import { defineConfig } from "oxlint";

import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

/**
 * Lint configuration.
 *
 * ultracite 7.9 ships its presets as JS modules rather than JSON, so the
 * presets are composed here and the project's rule overrides applied on top.
 *
 * Rule names are plugin-scoped. Several names exist in more than one plugin
 * (`no-negated-condition` and `no-nested-ternary` are both core-eslint and
 * unicorn rules), and an unprefixed key only silences the core-eslint one — so
 * where a rule is disabled below, every plugin that defines it is listed.
 *
 * Everything switched off here is stylistic. Rules that catch real defects stay
 * on; the handful of false positives they produce are suppressed at the call
 * site with a comment explaining why, so the rule keeps working everywhere else.
 */
export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [".agents/skills/**", "apps/web/components/ui/**"],
  rules: {
    "arrow-body-style": "off",
    "import/newline-after-import": "off",
    "import/no-duplicates": "off",
    "jsx-a11y/prefer-tag-over-role": "off",
    "logical-assignment-operators": "off",
    "no-duplicate-imports": "off",
    // Sequential awaits are load-bearing here: migrations, retry backoffs, and
    // ordered git operations must not be parallelized.
    "no-await-in-loop": "off",
    "node/callback-return": "off",
    "prefer-arrow-callback": "off",
    "prefer-named-capture-group": "off",
    "react/hook-use-state": "off",
    // React Compiler diagnostics on a codebase not written against it. The
    // correctness rule in this area, react/rules-of-hooks, stays an error.
    "react/react-compiler": "off",
    "require-unicode-regexp": "off",
    "typescript/method-signature-style": "off",
    "unicorn/import-style": "off",
    "unicorn/no-negated-condition": "off",
    "unicorn/prefer-export-from": "off",
    "unicorn/prefer-number-coercion": "off",
    "unicorn/prefer-single-call": "off",
    complexity: "off",
    curly: "off",
    "default-case": "off",
    eqeqeq: "off",
    "func-names": "off",
    "func-style": "off",
    "import/consistent-type-specifier-style": "off",
    "max-lines": "off",
    "class-methods-use-this": "off",
    "no-accumulating-spread": "off",
    "no-alert": "off",
    "no-bitwise": "off",
    "no-console": "off",
    "no-else-return": "off",
    "no-empty-function": "off",
    "no-eq-null": "off",
    "no-inline-comments": "off",
    "no-lonely-if": "off",
    "no-negated-condition": "off",
    "no-promise-executor-return": "off",
    "no-shadow": "off",
    "no-nested-ternary": "off",
    "no-plusplus": "off",
    "no-throw-literal": "off",
    "no-unmodified-loop-condition": "off",
    "no-use-before-define": "off",
    "no-useless-constructor": "off",
    "no-void": "off",
    "no-warning-comments": "off",
    "prefer-const": "off",
    "prefer-destructuring": "off",
    "prefer-object-spread": "off",
    "prefer-template": "off",
    "promise/avoid-new": "off",
    "promise/no-nesting": "off",
    "promise/no-promise-in-callback": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    "react/exhaustive-deps": "warn",
    "react/jsx-curly-brace-presence": "off",
    "react/jsx-no-constructed-context-values": "off",
    "react/jsx-no-useless-fragment": "off",
    "react/no-array-index-key": "off",
    "react/no-danger": "off",
    "react/rules-of-hooks": "error",
    "react-perf/jsx-no-new-function-as-prop": "off",
    "require-await": "off",
    "sort-keys": "off",
    "typescript/array-type": "off",
    "typescript/consistent-type-definitions": "off",
    "typescript/consistent-type-imports": "off",
    "typescript/no-dynamic-delete": "off",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "off",
    "typescript/no-inferrable-types": "off",
    "typescript/no-non-null-assertion": "off",
    "typescript/parameter-properties": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/consistent-existence-index-check": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-hex-escape": "off",
    "unicorn/no-lonely-if": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-typeof-undefined": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/number-literal-case": "off",
    "unicorn/numeric-separators-style": "off",
    "unicorn/prefer-at": "off",
    "unicorn/prefer-code-point": "off",
    "unicorn/prefer-negative-index": "off",
    "unicorn/prefer-node-protocol": "off",
    "unicorn/prefer-number-properties": "off",
    "unicorn/prefer-set-has": "off",
    "unicorn/prefer-spread": "off",
    "unicorn/prefer-string-replace-all": "off",
    "unicorn/prefer-dom-node-append": "off",
    "unicorn/prefer-logical-operator-over-ternary": "off",
    "unicorn/prefer-math-min-max": "off",
    "unicorn/prefer-math-trunc": "off",
    "unicorn/prefer-response-static-json": "off",
    "unicorn/prefer-string-slice": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/prefer-type-error": "off",
    "unicorn/switch-case-braces": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
});
