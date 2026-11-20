import { Link } from '@mui/material';
import { Fragment, type ReactNode } from 'react';

import type { JobDetailView } from '../../src/server/types.ts';
import { commitHref, knownCommits, logHref, prParts } from './format.ts';

/** Every link out of the detail view opens a new tab and leaks no referrer or opener. */
const external = { target: '_blank', rel: 'noreferrer noopener' } as const;

/**
 * A commit renderer for one detail: a GitHub link (short SHA, accessible name "Commit <sha8> on
 * GitHub") when the repository is on github.com and the commit is known to be on the remote;
 * otherwise the SHA as code, `len` characters long.
 */
export function commitRef(detail: JobDetailView): (sha: string, len?: number) => ReactNode {
  const known = knownCommits(detail);
  const repo = detail.links.repo;
  return (sha, len = 8) => {
    const href = known.has(sha) ? commitHref(repo, sha) : null;
    if (!href) return <code>{len >= sha.length ? sha : sha.slice(0, len)}</code>;
    const short = sha.slice(0, 8);
    return (
      <Link href={href} {...external} aria-label={`Commit ${short} on GitHub`}>
        <code>{short}</code>
      </Link>
    );
  };
}

/** A recorded log on the artifact route, or its path as plain text when it is not log-shaped. */
export function LogRef({
  jobId,
  path,
  label = '',
}: {
  jobId: string;
  path: unknown;
  label?: string;
}) {
  const href = logHref(jobId, path);
  return href ? (
    <Link href={href} {...external}>
      {label}
      {String(path)}
    </Link>
  ) : (
    <>{String(path)}</>
  );
}

/** The PR link itself; plain text when the read model has no http(s) PR URL. */
export function PrLink({
  url,
  pr,
  children,
}: {
  url: string;
  pr: string | null;
  children?: ReactNode;
}) {
  return pr ? (
    <Link href={pr} {...external}>
      {children ?? pr}
    </Link>
  ) : (
    <>{children ?? url}</>
  );
}

/** Text with its bounded occurrences of the PR URL linked (prParts); nothing else is linked. */
export function PrText({ text, pr }: { text: string; pr: string | null }) {
  return (
    <>
      {prParts(text, pr).map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <Link key={i} href={p.pr} {...external}>
            {p.pr}
          </Link>
        ),
      )}
    </>
  );
}
