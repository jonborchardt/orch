// Run by tests/vitest-config.test.ts from a lowercase-drive cwd (and by the suite as a plain test):
// tests/setup.ts's afterAll, this file's test, and jest-dom's matchers must all reach the runner's
// own `vitest` instance (docs/decisions/2026-11-24-vitest-lowercase-drive-cwd.md).
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';

test('vitest and jest-dom share the running Vitest instance', () => {
  expect(typeof expect(null).toHaveAttribute).toBe('function');
});
