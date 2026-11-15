# 5. Repository detection via `git rev-parse --show-toplevel` from the invoking cwd

Simplest correct answer, handles worktrees and nested dirs, and the CLI is useless without Git
anyway. Install location is derived from `import.meta.url`, so it is identical from `src/` and
`dist/` and independent of cwd. A job's repository identity is the normalized `origin` URL
(`github.com/org/repo`), falling back to the directory name, so clones of one repository share jobs.
