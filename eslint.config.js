import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'web/dist/',
      'coverage/',
      'node_modules/',
      'playwright-report/',
      'test-results/',
      '.claude/skills/log-todo/',
      // Claude Code session worktrees (`claude --worktree`): full checkouts, linted in their own.
      '.claude/worktrees/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['*.config.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
