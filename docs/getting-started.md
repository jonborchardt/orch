# Getting started: from clone to a first merged ticket

For someone who has just found `orch` and wants to use it on their own repositories. Follow the
sections in order. Each one ends with something you can check before going on. The
[README](../README.md) says what `orch` is and what it guarantees;
[operations.md](operations.md) is the full reference for running it.

## 1. Prerequisites

| You need                          | Check it with      | Notes                                                                                                                                       |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 or newer               | `node --version`   | `orch` runs TypeScript with Node's own type stripping.                                                                                      |
| Git                               | `git --version`    | Every job works in its own Git worktree.                                                                                                    |
| GitHub CLI, signed in             | `gh auth status`   | Sign in with `gh auth login`. `orch` reaches GitHub only through `gh`.                                                                      |
| Claude Code, native and signed in | `claude --version` | Native `claude` first on PATH, signed in (run `claude` once); a Windows `claude.cmd` shim is refused.                                       |
| VS Code (optional)                | `code --version`   | Only for interactive Claude Code sessions in an editor; a terminal `claude` session works as well.                                          |
| A Claude plan for long sessions   | (nothing to run)   | One job is a headless session that can run for an hour or more with several subagents. A plan with a small usage limit stalls in the queue. |

On Windows, check which `claude` is found first with `where.exe claude`; on macOS and Linux,
`which claude`. Why the shim is refused:
[workflow.md](workflow.md#claude-code-configuration).

Your repositories must be on GitHub, with `origin` pointing there.

## 2. Install

```sh
git clone https://github.com/jonborchardt/orch && cd orch
npm install
npm run build      # compiles to dist/, which the orch command runs
npm link           # puts orch on PATH
orch install       # links the factory skill and its agents into ~/.claude
```

Restart Claude Code now: it reads skills only when a session starts. Then:

```sh
orch doctor
```

Every row should say `OK`. The rows that can say something else:

| Row                 | Status and what to do                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js             | FAIL: Node is older than 24.0.0. Install Node 24 or newer.                                                                                         |
| Git                 | FAIL: `git` is not on PATH. Install Git and reopen the terminal.                                                                                   |
| Claude Code         | WARN: `claude` is not on PATH. Install the native Claude Code and sign in; jobs cannot run without it.                                             |
| GitHub CLI          | WARN: `gh` is not on PATH. Install it and run `gh auth login`; pull requests, CI, and merging need it.                                             |
| Project repository  | WARN: the current directory is not inside a Git repository. Nothing to fix; run `orch doctor` inside one of your repositories to check it too.     |
| Verification policy | WARN: this repository has no usable `factory.json` on its base branch. Expected until section 3; the row prints the reason and the command to run. |
| Skills and agents   | WARN: a skill or agent in `~/.claude` is missing or older than the clone. Run `orch install`, then restart Claude Code.                            |

`orch doctor` only checks that `claude` and `gh` are found, not that they are signed in or that
`claude` is the native build; the checks in section 1 cover that.

**Updating.** In the clone: `git pull`, `npm run build`, `orch install`, then restart Claude
Code. Do not rebuild while a controller (`orch start`, `orch do`) is running.

## 3. Onboard a repository

`orch` runs only the checks a repository has committed in its own `factory.json`, and reads that
file from the base branch, not from the job's edits. Write it once per repository:

```sh
cd ~/code/my-app
orch init --from-package-json                           # npm scripts: check, else test, lint, typecheck; plus build
orch init --command "test=cargo test" --command "lint=cargo clippy"   # or name the checks yourself
```

Use one of the two forms. Nothing is executed or committed; the command writes `factory.json` and
tells you to review it. A good policy:

- has at least one required check that runs the tests. The evidence `orch` collects is only as
  good as these checks;
- names executables that are on PATH (`npm`, `cargo`, `pytest`), with their arguments as an
  array. There are no shell strings: no `&&`, pipes, or redirection;
- takes minutes, not hours, because it runs on every build round.

Open the file `orch init` wrote; it has a `verification.commands` list of
`{ "id", "command", "args" }` entries.

Commit and push it to the base branch, then ask whether the repository is ready:

```sh
git add factory.json && git commit -m "Add factory verification policy" && git push
orch init --check
```

`orch init --check` prints `READY`, or exactly what is missing and the command that fixes it. It
also prints a readiness grade from A to D
([what it counts](../README.md#configure-a-repository)). The grade is advice; it blocks nothing.

Two GitHub settings on the base branch make merging safe, and they are what moves the grade to
A. Set them under Settings, Branches (or Rulesets) for the base branch:

- **Require status checks to pass before merging**, with your CI checks selected. `orch` merges
  only a head whose required checks passed.
- **Require branches to be up to date before merging.** This closes the window in which the base
  moves between CI passing and the merge.

Without CI on the repository `orch` still works, on the evidence of the policy alone. More on
policies, including `"authority": "ci"` for a repository whose CI runs the full suite:
[README](../README.md#configure-a-repository).

## 4. Your first ticket

Pick something small and unambiguous that your tests can prove: a bug with a clear reproduction,
a missing validation, a small documented option. Not a refactor, and not anything you could not
specify in a paragraph.

```sh
cd ~/code/my-app
orch ticket add "Reject empty names in the signup form" --type bug --priority P2
orch ticket ready      # the ticket is listed, with its id (for example 0001; 1 names it too)
```

Priorities, dependencies, and how readiness is computed: [tickets.md](tickets.md).

Open the dashboard in a second terminal and leave it running:

```sh
orch ui --open         # http://127.0.0.1:4777/
```

**Run the first ticket by hand, and merge it yourself.** There is an unattended command,
`orch do <ticket-id>`, which runs one ticket from start to merge. It refuses to start a job for a
repository where merging is not enabled yet ("merging without a human click is not enabled ... so
the ticket is not started"), and merging should stay off until you have watched one job
(section 5). So the first ticket runs in a session you can watch and talk to.

Open an interactive Claude Code session in the repository (`claude` in a terminal there, or the
VS Code extension) and ask it, with your ticket's id:

```
Run `orch factory start --ticket 1 --json`, then carry that job through with the /factory skill.
```

Let the session run that command itself, not your own terminal
([why](operations.md#running-a-job-without-the-controller)). If the session ends early, a new
session continues the same job with `/factory <job-id>` (the id looks like `job-1a2b3c4d`;
`orch factory list` shows it).

What you will see on the dashboard's job page, stage by stage. The times are rough figures for a
small ticket and nothing more: they depend on the size of the change, on how long your checks
take, and on your CI. `orch job usage <job-id>` shows where a finished job's time really went.

| Stage         | What happens                                                                | Roughly             |
| ------------- | --------------------------------------------------------------------------- | ------------------- |
| `spec`        | An agent writes `spec.md` with acceptance criteria; a second challenges it. | 5 to 15 minutes     |
| `build`       | A builder implements the spec and commits; your `factory.json` checks run.  | 10 to 40 minutes    |
| `simplify`    | A simplifier looks for over-engineering; the checks run again.              | 5 to 15 minutes     |
| `review`      | Reviewers read the diff; blocking findings send the job back to `build`.    | 10 to 20 minutes    |
| `approve`     | An approver compares the result with the spec and decides.                  | about 5 minutes     |
| `pr`          | `orch` pushes the branch and opens a draft pull request.                    | 1 to 2 minutes      |
| `ci`          | `orch` waits for GitHub's required checks on that exact commit.             | as long as your CI  |
| `completed`   | CI passed and the pull request is marked ready. Nothing is merged yet.      |                     |
| `needs-human` | Not a step: the job stopped at a decision only you can make. See section 6. | until you answer it |

A whole job on a small ticket usually takes somewhere between 45 minutes and 2 hours, and each
extra review round adds a build and a review. Roles, reviewers, and round limits:
[workflow.md](workflow.md).

When the job is `completed`, read the pull request, then merge it one of two ways:

- click **Merge** on the job's page in the dashboard, which merges exactly the verified commit
  and closes the ticket; or
- merge on GitHub, then click **Refresh PR** on the job's page so the dashboard shows it, and run
  `orch job merge <job-id>`, which records a merge GitHub already made and closes the ticket (it
  needs no opt-in for that).

`orch ticket show <ticket-id>` now says `done`. The dashboard offers **Remove worktree** for the
finished job; the branch is kept.

## 5. Turn on merging, then run the queue

Do this only after you have watched one job go through and read its pull request. It lets `orch`
merge that repository's verified pull requests without your click. It is off by default, set per
repository, stored in your own configuration and never in a repository, and it lifts no check.

```sh
orch factory config merge enable --repo ~/code/my-app   # or run it inside the repository, without --repo
orch factory config merge status --repo ~/code/my-app
```

From the second ticket on:

```sh
orch do 2          # one ticket: its job, CI, the merge, then exit
orch start         # the whole ready queue, best ticket first, one at a time
orch stop next     # from another terminal: finish the current ticket, start no other, exit
```

Both run in the foreground, in a terminal you leave open; nothing keeps running after the
command exits. `orch start` passes over tickets of repositories that are not opted in.
`orch status` shows what the controller is doing. What happens at every step:
[operations.md](operations.md#a-walkthrough).

## 6. When a job needs you

A job goes to `needs-human` when it reaches a decision the code will not make for you: the
approver escalated, reviewers still reject at the round limit, CI fails for a reason that is not
the code. The job waits; nothing is lost. You will see it in three places:

- `orch status` lists each waiting job first, with what is needed and one link per choice;
- the summary `orch start` or `orch do` prints when it ends has the same lines, and the command
  exits with status 1;
- the dashboard's job page shows a **Needs you** block at the top.

To answer, pick a choice in the **Needs you** block on the job's page, or open one of the
`?choose=<n>` links from `orch status` (`orch ui` must be running). Then continue the same job:

```sh
orch do <ticket-id>
```

Every choice and what it does: [operations.md](operations.md#resolving-needs-human) and
[dashboard.md](dashboard.md).

## 7. Three first-day problems

**No policy on the base branch.** Symptom: `orch init --check` does not print `READY`,
`orch doctor` shows `WARN Verification policy`, or a job cannot pass its build stage. A
`factory.json` that exists only in your working tree, or is committed but not pushed, does not
count. Fix:

```sh
orch init --from-package-json      # or --command "<id>=<executable> [args...]"
git add factory.json && git commit -m "Add factory verification policy" && git push
orch init --check
```

**The runner's allow-list is missing a tool.** Symptom: under `orch start` or `orch do` a job
stops making progress in `build`, in a repository whose builder needs something other than
`orch`, `git`, `npm`, `npx`, `node`, and `cd` (for example `pnpm`, `cargo`, or `pytest`). The
headless session may not run a command outside the list, and nobody is there to approve it. `orch init --check` lists a check executable the list does not cover under `uncovered`. Fix:
add the rule to your own `<config>/factory.json` (`orch factory config` prints where that file
is), under `repoAllowedTools` for that repository, for example
`{"repoAllowedTools": {"github.com/acme/web": ["Bash(cargo *)"]}}`, or under `extraAllowedTools`
for every repository. The defaults are kept; there is no need to repeat them. The full example:
[workflow.md](workflow.md#claude-code-configuration).

**An interrupted session.** Symptom: the terminal running `orch start` or `orch do` was closed,
the machine slept or restarted, and now `orch start` and `orch do` refuse because an interrupted
session exists. The job kept its stage, its artifacts, and its worktree. Fix:

```sh
orch resume        # continue: same ticket, same job, from where it stopped
orch stop          # or discard the interrupted session, then orch start or orch do again
```

Discarding the session cancels nothing: the job stays as it is, and `orch do <ticket-id>`
continues it. If either command refuses because a Claude process may have survived, follow
[operations.md](operations.md#a-claude-process-that-may-have-survived).
