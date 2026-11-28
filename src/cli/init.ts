/** `orch init`: write a reviewed factory.json, or report repository readiness with --check. */
import { UsageError } from '../core/errors.ts';
import { type GradedReadiness, gradedReadiness, initRepo, type InitResult } from '../ops/init.ts';

export interface InitOptions {
  repo?: string;
  command?: string[];
  'from-package-json'?: boolean;
  force?: boolean;
  check?: boolean;
}

export const INIT_HELP = `Usage: orch init [--repo <path>] --command "<id>=<executable> [args...]" [--command ...]
       orch init [--repo <path>] --from-package-json [--command ...]
       orch init [--repo <path>] --check

  Writes factory.json at the root of the current (or --repo) Git repository with the verification
  checks you name, then tells you how to review and commit it. Nothing is executed or committed.
  --command            One check: an id, "=", an executable on PATH, and its arguments.
  --from-package-json  Use npm run <script> for the conventional scripts package.json defines
                       (check, else test/lint/typecheck, plus build). Suggestions are only
                       written with this flag.
  --force              Replace an existing factory.json (refused otherwise).
  --check              Read-only: is factory.json present, valid, committed on the branch a job
                       would start from (pushed when origin/<branch> exists), and are its
                       executables on PATH? Exit 1 unless ready. Also prints a readiness
                       grade, A to D, counting four facts: a policy check that runs tests, and,
                       when origin is on github.com (read with gh), required status checks,
                       up-to-date branches (or a merge queue), and protection on the base
                       branch. The grade is advice: it never changes the exit code.
                       Inside a Git repository it also prints "allowed", the --allowedTools a
                       factory session here gets (runnerClaudeArgs or the defaults, plus
                       extraAllowedTools and this repository's repoAllowedTools from your
                       <config>/factory.json). When the policy is ready and a check's
                       executable is not covered (no Bash, Bash(*), Bash(<exe> *), or
                       Bash(<exe>:*) rule and no permission bypass), the gap is listed with
                       the exact repoAllowedTools setting that closes it, and the grade is
                       capped at B.

The factory trusts the factory.json committed at the merge base of a job and its base branch,
never the copy a job edits, so the policy must be committed (and pushed) before the first job.
`;

export function runInit(
  args: string[],
  o: InitOptions,
  cwd = process.cwd(),
): InitResult | GradedReadiness {
  if (args.length > 0) {
    throw new UsageError(`Unexpected argument: ${args[0] ?? ''}\n\n${INIT_HELP}`);
  }
  if (o.check) return gradedReadiness(cwd, o.repo);
  return initRepo({
    cwd,
    repo: o.repo,
    commands: o.command,
    fromPackageJson: o['from-package-json'],
    force: o.force,
  });
}

export function formatInit(r: InitResult | GradedReadiness): string {
  if ('status' in r) {
    const lines = [`${r.ready ? 'READY' : r.status.toUpperCase()}  ${r.detail}`];
    if (r.path) lines.push(`policy    ${r.path}`);
    if (r.baseRef) lines.push(`baseline  ${r.baseRef}`);
    if (r.checks.length) lines.push(`checks    ${r.checks.join(', ')}`);
    if (r.next) lines.push(`next      ${r.next}`);
    if (r.allowedTools) lines.push(`allowed   ${r.allowedTools.join(', ')}`);
    if (r.grade) {
      lines.push(`grade     ${r.grade.letter} (${String(r.grade.met)}/4)`);
      if (r.grade.uncovered.length) lines.push(`uncovered ${r.grade.uncovered.join(', ')}`);
      lines.push(...r.grade.advice.map((a) => `          - ${a}`));
    }
    return lines.join('\n');
  }
  return [
    `${r.replaced ? 'Replaced' : 'Wrote'} ${r.path} for ${r.repo}`,
    ...r.checks.map((c) => `  ${c}`),
    '',
    'Next:',
    ...r.next.map((s, i) => `  ${String(i + 1)}. ${s}`),
  ].join('\n');
}
