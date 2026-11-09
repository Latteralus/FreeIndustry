// Jest runs pure TypeScript compiled to CommonJS by ts-jest (tsconfig.jest.json).
// Convention: `*.test.ts` runs in Node; `*.test.tsx` runs in jsdom.
// Playwright end-to-end specs use `*.spec.ts` and are never collected by Jest.

const transform = {
  '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
};

const ignore = ['<rootDir>/node_modules/', '<rootDir>/out/', '<rootDir>/release/'];

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      testMatch: ['**/*.test.ts'],
      testPathIgnorePatterns: [...ignore, '<rootDir>/tests/e2e/'],
      modulePathIgnorePatterns: ignore,
      transform,
    },
    {
      displayName: 'renderer',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      testMatch: ['**/*.test.tsx'],
      testPathIgnorePatterns: [...ignore, '<rootDir>/tests/e2e/'],
      modulePathIgnorePatterns: ignore,
      moduleNameMapper: {
        '\\.css$': '<rootDir>/tests/support/style-stub.cjs',
        // jsdom has no GPU: the PixiJS factory scene is replaced by a recording fake (ADR-0051).
        '(^|/)pixi/pixi-factory-scene$': '<rootDir>/tests/support/fake-factory-scene.ts',
      },
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
      transform,
    },
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/**/*.test.{ts,tsx}'],
};
