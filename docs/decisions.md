# Decisions

Short records of choices that are not obvious from the code. Newest last.

## 1. Single package, no workspaces (Phase 1)

One `package.json`, one `tsconfig`. The dashboard, skills, and agents will live in subdirectories
of the same package until something actually needs separate publishing or dependency isolation.

## 2. Node native type stripping instead of `tsx`

Node >= 22.18 runs `.ts` files directly. `erasableSyntaxOnly` in `tsconfig.json` guarantees source
stays strippable (no enums, parameter properties, or namespaces). Relative imports use `.ts`
extensions; `rewriteRelativeImportExtensions` makes `tsc` emit `.js` in `dist/`. One less dependency
and one less execution path to debug. Minimum engine is therefore `>=22.18.0`.

## 3. `node:util` `parseArgs` for the CLI

Three commands do not justify a CLI framework. Revisit if subcommands grow nested options or we
need generated help; until then, help text is a string.

## 4. Runtime state in OS user directories, `ORCH_HOME` override

Windows: `%APPDATA%\orch` (config) and `%LOCALAPPDATA%\orch` (data). macOS: Application Support.
Linux: XDG. One env var redirects everything, which is how tests and development installs avoid
the real directories. Nothing mutable is ever written into the package install root or a Claude
skill directory, so `npm link` and junction-linked skills stay safe.

## 5. Repository detection via `git rev-parse --show-toplevel` from the invoking cwd

Simplest correct answer, handles worktrees and nested dirs, and the CLI is useless without Git
anyway. Install location is derived from `import.meta.url`, so it is identical from `src/` and
`dist/` and independent of cwd.

## 6. Tool probing goes through the shell on Windows

`execSync('<tool> --version')` rather than `execFileSync`, because Windows installs Claude Code,
`gh`, and npm-linked binaries as `.cmd`/`.exe` shims that only the shell resolves, and Node 24
deprecates `spawn(cmd, args, { shell: true })`. Tool names are constants, never user input.

## 7. `doctor` exit codes

Missing Node version or Git is a `fail` (exit 1). Missing Claude Code or GitHub CLI is a `warn`,
because the CLI itself still works and CI machines will not have them.

## 8. Global skills via links, not copies or plugins

Planned `orch install` creates `~/.claude/skills/<name>` and `~/.claude/agents/<name>.md` links to
this repo. Windows uses directory junctions (`fs.symlink(target, path, 'junction')`), which need
no elevation or Developer Mode. Edits here are live everywhere. The installer owns only its own
entries and never modifies project `CLAUDE.md` files or other skills.

## 9. SQLite driver deferred

Candidates: `node:sqlite` (built in, experimental in 22, stable-ish in 24), `better-sqlite3`
(native build), `sql.js` (WASM, no concurrent-process safety). Decide in Phase 2 when the schema
exists. All access will sit behind `src/storage/` so the choice is reversible.
