// ESLint flat config. Prettier owns formatting; ESLint owns correctness,
// React/a11y rules and the module-boundary rules from specification §4.4.
import { builtinModules } from 'node:module';
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
// Maintained fork of eslint-plugin-jsx-a11y with ESLint 10 support (DECISIONS ADR-0011).
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import { importX } from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const LAYERS = [
  'main',
  'preload',
  'worker',
  'domain',
  'simulation',
  'persistence',
  'catalog',
  'renderer',
  'shared',
];

const UI_PACKAGES = ['react', 'react-dom', 'pixi.js'];
const ELECTRON = ['electron'];
const SQLITE = ['better-sqlite3'];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Restrict what a source layer may import.
 * Packages and Node built-ins are matched by exact specifier (plus subpaths),
 * never by gitignore-style globs: Node has built-ins named `domain`, `module`
 * and `events`, which a glob would confuse with our own directories.
 * @param {string} layer directory under src/
 * @param {{ allowLayers: string[], forbidPackages: string[], forbidNode?: boolean }} rules
 */
function layerBoundary(layer, { allowLayers, forbidPackages, forbidNode = false }) {
  const forbiddenLayers = LAYERS.filter((other) => other !== layer && !allowLayers.includes(other));
  const packageMessage = `src/${layer} must not depend on this package (spec §4.4 module boundaries).`;
  const nodeMessage = `src/${layer} is pure TypeScript: no Node.js built-ins (spec §4.4).`;

  const paths = forbidPackages.map((name) => ({ name, message: packageMessage }));
  if (forbidNode) {
    for (const name of builtinModules) {
      paths.push({ name, message: nodeMessage }); // `node:`-prefixed forms: pattern below
    }
  }

  const patterns = forbiddenLayers.map((other) => ({
    // A relative specifier that passes through a directory named after the layer.
    regex: `^\\.{1,2}/(?:.*/)?${other}(?:/|$)`,
    message: `src/${layer} must not import from src/${other} (spec §4.4 module boundaries).`,
  }));
  if (forbidPackages.length > 0) {
    patterns.push({
      regex: `^(?:${forbidPackages.map(escapeRegex).join('|')})/`,
      message: packageMessage,
    });
  }
  if (forbidNode) {
    patterns.push({ regex: '^node:', message: nodeMessage });
  }

  return {
    files: [`src/${layer}/**/*.{ts,tsx}`],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { paths, patterns }] },
  };
}

// import-x needs its TypeScript parser/extension settings for cycle detection;
// the legacy `resolver` key is replaced by `resolver-next` below.
const { 'import-x/resolver': _legacyResolver, ...importXTypeScriptSettings } =
  importX.flatConfigs.typescript.settings;

const PURE = [...ELECTRON, ...UI_PACKAGES, ...SQLITE];

export default defineConfig(
  {
    ignores: [
      'out/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.cjs', '*.mjs', 'tests/support/*.cjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    settings: {
      ...importXTypeScriptSettings,
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json', alwaysTryTypes: true }),
      ],
    },
    rules: {
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-duplicates': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // Plain JavaScript config files are not type-checked.
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Renderer: React hooks and accessibility.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/**/*.tsx'],
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/**/*.tsx'],
    ...jsxA11y.configs.recommended,
    languageOptions: { ...jsxA11y.configs.recommended.languageOptions, globals: globals.browser },
  },

  // Deterministic simulation: no ambient randomness or wall-clock time (spec §9.4, D09).
  {
    files: [
      'src/domain/**/*.ts',
      'src/simulation/**/*.ts',
      'src/catalog/**/*.ts',
      'src/shared/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded simulation RNG (§9.4).' },
        { object: 'Date', property: 'now', message: 'Use the simulation clock, not wall time.' },
        {
          object: 'performance',
          property: 'now',
          message: 'Use the simulation clock, not wall time.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use the simulation clock, not wall time.',
        },
      ],
    },
  },

  // Module boundaries (spec §4.4). Electron main owns platform functions only;
  // the worker owns simulation and SQLite; the renderer sees shared DTOs only.
  layerBoundary('shared', { allowLayers: [], forbidPackages: PURE, forbidNode: true }),
  layerBoundary('domain', { allowLayers: ['shared'], forbidPackages: PURE, forbidNode: true }),
  layerBoundary('simulation', {
    allowLayers: ['domain', 'shared'],
    forbidPackages: PURE,
    forbidNode: true,
  }),
  layerBoundary('catalog', {
    allowLayers: ['domain', 'shared'],
    forbidPackages: PURE,
  }),
  layerBoundary('persistence', {
    allowLayers: ['domain', 'catalog', 'shared'],
    forbidPackages: [...ELECTRON, ...UI_PACKAGES],
  }),
  layerBoundary('worker', {
    allowLayers: ['domain', 'simulation', 'persistence', 'catalog', 'shared'],
    forbidPackages: [...ELECTRON, ...UI_PACKAGES],
  }),
  layerBoundary('main', { allowLayers: ['shared'], forbidPackages: [...UI_PACKAGES, ...SQLITE] }),
  layerBoundary('preload', {
    allowLayers: ['shared'],
    forbidPackages: [...UI_PACKAGES, ...SQLITE],
  }),
  layerBoundary('renderer', {
    allowLayers: ['shared'],
    forbidPackages: [...ELECTRON, ...SQLITE],
    forbidNode: true,
  }),

  prettier,
);
