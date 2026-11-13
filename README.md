# agent-orchestrator

A local, multi-repository AI software factory driven by Claude Code.

One global installation serves any number of project repositories. A globally installed Claude
skill starts a factory job from a Claude Code session in any repo. Each job owns a Git worktree and
a primary Claude session, which delegates planning, implementation, testing, and review to
specialized subagents. The workflow moves through deterministic states enforced by TypeScript, with
shared state in a single local SQLite database and a CLI (`orch`) that agents and humans both use.
Output is a draft GitHub PR; humans keep merge authority.

**Status:** Phase 1, scaffolding only. The CLI runs `--help`, `--version`, and `doctor`. No jobs,
workflow, database, skills, or dashboard exist yet.

## Principles

- **Deterministic core, agentic edges.** State transitions and rules live in code. LLM sessions do
  the creative work and interact with state only through the CLI.
- **No separate LLM supervisor.** Claude Code sessions and their subagents are the workers; this
  project supplies instructions, rules, state, and tooling.
- **Resumable from persisted state.** Jobs recover from the database, artifacts, and Git, never
  from a surviving conversation.
- **Local-first, one developer, one machine.** Windows + VS Code first, cross-platform by default.
- **Minimal dependencies.** Node built-ins before libraries, libraries before frameworks.

## Stack

| Concern       | Choice                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| Runtime       | Node.js >= 22.18 (24 LTS recommended), ESM, TypeScript strict           |
| Dev execution | `node src/cli/main.ts` via Node's native type stripping (no `tsx`)      |
| Build         | `tsc` to `dist/`                                                        |
| Tests         | Vitest with V8 coverage                                                 |
| Lint / format | ESLint (typescript-eslint, type-checked) + Prettier                     |
| CLI parsing   | `node:util` `parseArgs`                                                 |
| Persistence   | SQLite (driver chosen in Phase 2; `node:sqlite` is the first candidate) |
| Dashboard     | Deferred; planned React + Vite + Material UI under `web/`               |

Runtime dependencies: none.

## Layout

```
src/
  cli/           orch entry point and commands (main.ts, doctor.ts)
  core/          domain types and conventions (paths.ts)
tests/           Vitest suites, mirror src/
docs/            decisions.md and future design notes
.github/workflows/ci.yml
```

Planned, created when first needed: `src/storage/` (SQLite behind one module), `src/git/`
(worktrees), `src/integrations/` (Claude Code, GitHub), `skills/` and `agents/` (source-controlled
Claude skills and subagents), `web/` (dashboard).

## Install and develop

```sh
git clone <this repo> && cd agent-orchestrator
npm install            # also builds dist/ via the prepare script
npm link               # puts `orch` on PATH from any directory
orch doctor
```

`npm link` creates a global shim pointing at `dist/cli/main.js`, so run `npm run build` after
changing source. During development, run from source without building:

```sh
npm run dev -- doctor
node src/cli/main.ts --help
```

Both work from any directory. Repository detection uses the invoking directory, never the install
location.

### Validation

```sh
npm run check          # typecheck + lint + format:check + test
npm run test:coverage  # coverage report (text + lcov in coverage/)
npm run format         # apply Prettier
npm run build
```

CI runs the same commands on Ubuntu and Windows.

## Runtime paths

All mutable state lives under per-user OS directories, never inside this package or any Claude
skill directory. Set `ORCH_HOME` to redirect everything to one directory (used by tests and for
side-by-side development installs).

| Purpose | Windows               | macOS                                | Linux                   |
| ------- | --------------------- | ------------------------------------ | ----------------------- |
| config  | `%APPDATA%\orch`      | `~/Library/Application Support/orch` | `$XDG_CONFIG_HOME/orch` |
| data    | `%LOCALAPPDATA%\orch` | same as config                       | `$XDG_DATA_HOME/orch`   |
| logs    | `<data>\logs`         | `<data>/logs`                        | `<data>/logs`           |
| tmp     | `<data>\tmp`          | `<data>/tmp`                         | `<data>/tmp`            |

The shared SQLite database will live in `<data>`. Per-job worktrees will live under `<data>` as
well, outside the project repositories.

## Global Claude skills (planned)

Skills and subagent definitions will be source-controlled here under `skills/<name>/SKILL.md` and
`agents/<name>.md`. A future `orch install` command will link them into the user's global Claude
configuration:

- `~/.claude/skills/<name>` -> `<install root>/skills/<name>`
- `~/.claude/agents/<name>.md` -> `<install root>/agents/<name>.md`

Links are directory junctions on Windows (`fs.symlink(..., 'junction')`, no admin or Developer Mode
required) and symlinks elsewhere, so edits in this repo are live globally with no copying. The
installer only adds entries it owns and never touches a project's `CLAUDE.md`, `.claude/`, or
existing global skills. No Claude plugin or marketplace is involved.

## Deferred

Workflow state machine, job commands, SQLite schema and driver, Git worktree management, skill and
agent definitions, the install/link command, GitHub integration, the web dashboard, and any daemon
or background process. See `docs/decisions.md` for the reasoning behind what exists.
