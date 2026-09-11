// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nodePlugin from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // ── Base JS rules ──────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript strict + type-checked ───────────────────────
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ── Node.js 24 rules ──────────────────────────────────────
  nodePlugin.configs['flat/recommended-module'],

  // ── Prettier compat (disables formatting rules) ────────────
  prettierConfig,

  // ── Project-level config ───────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── TypeScript strict (all errors, zero tolerance) ─────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ── Node.js 24 ────────────────────────────────────────
      'n/no-deprecated-api': 'error',
      'n/no-unsupported-features/node-builtins': 'error',
      'n/no-missing-import': 'off',

      // `bin` points at the tsc BUILD output (dist/local-mcp/cli.js), but the
      // file eslint actually sees is the source (src/local-mcp/cli.ts). Without
      // this mapping n/hashbang cannot connect the two: it decides cli.ts is not
      // a bin entry and reports "This file needs no shebang" on the shebang the
      // published CLI genuinely requires (an npm-installed `bin` symlink is
      // exec'd by the shell, which parses the file as sh without it). convertPath
      // teaches the rule the src->dist mapping so it evaluates the real published
      // path — the correct fix rather than disabling the rule (INV-NO-LINT).
      'n/hashbang': [
        'error',
        {
          convertPath: {
            'src/**/*.ts': ['^src/(.+)\\.ts$', 'dist/$1.js'],
          },
        },
      ],

      // ── Security (baseline) ────────────────────────────────
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // ── Code quality ───────────────────────────────────────
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Ignore patterns ────────────────────────────────────────
  // `test/` holds plain node:test unit/fixture suites (e.g. projector fixture
  // tests) — same rationale as `scripts/`: freeform Node scripts outside the
  // tsc project, not part of the shipped dist/ output.
  //
  // `src/registry/projectors/__tests__/` holds this same kind of plain
  // node:test suite (e.g. claude.test.mjs) colocated with the projector it
  // tests rather than under top-level `test/` — same rationale, ignored for
  // the same reason (a typed-linting `parserOptions.project` parse error on a
  // .mjs file that tsc never compiles, since `allowJs` is off).
  //
  // `.agent/planning/saferoom-workflow.js` is the Workflow-tool orchestration
  // script that drove the P0-P5 build (kept as a process/reference artifact,
  // per .agent/planning/VSIX-PLAN.md) — not application code, never compiled,
  // and uses the Workflow tool's own top-level await/return script convention
  // rather than a standard module shape. Same rationale as the other ignores.
  {
    ignores: [
      'dist/',
      'dist-ext/',
      'node_modules/',
      '.yarn/',
      '.pnp.*',
      'eslint.config.mjs',
      'scripts/',
      'src/supply-chain/',
      'test/',
      'src/registry/projectors/__tests__/',
      '.agent/planning/saferoom-workflow.js',
    ],
  },
);
