import {
  Alert,
  Box,
  Button,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { TokenCounts, UsageBucket, UsageRange, UsageView } from '../../src/server/types.ts';
import { Polled } from './Runs.tsx';
import { fetchUsage } from './api.ts';

const RANGES: { hours: UsageRange; label: string }[] = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];
const KINDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheCreation', label: 'Cache creation' },
] as const;

const sum = (c: TokenCounts) => c.input + c.output + c.cacheRead + c.cacheCreation;
const n = (x: number) => x.toLocaleString();
const hourLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function bucketText(b: UsageBucket): string {
  const base = `${hourLabel(b.hour)}: ${n(sum(b))} tokens`;
  return b.missing.length ? `${base}, missing data for ${b.missing.join(', ')}` : base;
}

/** Stacked bars, one per hour; an hour with a missing source is hatched and outlined, and says so. */
function Chart({
  buckets,
  fills,
  hatch,
}: {
  buckets: UsageBucket[];
  fills: string[];
  hatch: string;
}) {
  const W = 10;
  const HT = 160;
  const max = Math.max(1, ...buckets.map(sum));
  return (
    <svg
      viewBox={`0 0 ${String(buckets.length * W)} ${String(HT)}`}
      preserveAspectRatio="none"
      width="100%"
      height={HT}
      aria-label="Tokens per hour"
      role="group"
    >
      <defs>
        <pattern
          id="usage-missing"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke={hatch} strokeWidth="1.5" />
        </pattern>
      </defs>
      {buckets.map((b, i) => {
        let y = HT;
        const text = bucketText(b);
        return (
          <g key={b.hour} role="img" aria-label={text}>
            <title>{text}</title>
            {b.missing.length > 0 && (
              <rect
                x={i * W + 1}
                y={0}
                width={W - 2}
                height={HT}
                fill="url(#usage-missing)"
                stroke={hatch}
                strokeDasharray="2 2"
                opacity={0.6}
              />
            )}
            {KINDS.map((k, j) => {
              const h = (b[k.key] / max) * HT;
              y -= h;
              return h > 0 ? (
                <rect key={k.key} x={i * W + 1} y={y} width={W - 2} height={h} fill={fills[j]} />
              ) : null;
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function UsagePage() {
  const [hours, setHours] = useState<UsageRange>(24);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { palette } = useTheme();
  const fills = [
    palette.primary.main,
    palette.secondary.main,
    palette.success.main,
    palette.warning.main,
  ];

  // Loads on open, on a range change, and on Refresh; never polls (each load reads transcripts).
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUsage(hours)
      .then(
        (v) => {
          if (!live) return;
          setData(v);
          setError(null);
        },
        (err: unknown) => {
          if (live) setError(err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [hours, nonce]);

  const missingHours = data?.buckets.filter((b) => b.missing.length > 0).length ?? 0;
  return (
    <Polled label="Usage" error={error} loaded={data !== null}>
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={hours}
          aria-label="Range"
          onChange={(_, v: UsageRange | null) => {
            if (v !== null) setHours(v);
          }}
        >
          {RANGES.map((r) => (
            <ToggleButton key={r.hours} value={r.hours}>
              {r.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button
          size="small"
          onClick={() => {
            setNonce((x) => x + 1);
          }}
          disabled={loading}
        >
          Refresh
        </Button>
      </Stack>
      {data && (
        <>
          {!data.total.complete && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Incomplete: some jobs&apos; transcripts could not be read, so these totals are a lower
              bound.{' '}
              {missingHours === 1
                ? '1 hour with missing data is hatched in the chart.'
                : `${String(missingHours)} hours with missing data are hatched in the chart.`}
            </Alert>
          )}
          <TableContainer sx={{ mb: 2 }}>
            <Table size="small" aria-label="Usage total">
              <TableBody>
                {KINDS.map((k, j) => (
                  <TableRow key={k.key}>
                    <TableCell component="th" scope="row">
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          mr: 1,
                          bgcolor: fills[j],
                        }}
                      />
                      {k.label}
                    </TableCell>
                    <TableCell align="right">{n(data.total[k.key])}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell component="th" scope="row">
                    Total{data.total.complete ? '' : ' (incomplete)'}
                  </TableCell>
                  <TableCell align="right">{n(sum(data.total))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
          <Chart buckets={data.buckets} fills={fills} hatch={palette.error.main} />
          <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              {data.buckets[0] ? hourLabel(data.buckets[0].hour) : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Hourly, local time. Hatched: a job&apos;s transcript could not be read.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {data.buckets.at(-1) ? hourLabel(data.buckets.at(-1)?.hour ?? '') : ''}
            </Typography>
          </Stack>
          <TableContainer>
            <Table size="small" aria-label="Usage per job">
              <TableHead>
                <TableRow>
                  <TableCell>Job</TableCell>
                  {KINDS.map((k) => (
                    <TableCell key={k.key} align="right">
                      {k.label}
                    </TableCell>
                  ))}
                  <TableCell align="right">Total</TableCell>
                  <TableCell>Missing</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell component="th" scope="row">
                      <Link href={`#/jobs/${j.id}`}>{j.title}</Link>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block' }}
                      >
                        {j.id}
                      </Typography>
                    </TableCell>
                    {KINDS.map((k) => (
                      <TableCell key={k.key} align="right">
                        {n(j[k.key])}
                      </TableCell>
                    ))}
                    <TableCell align="right">{n(sum(j))}</TableCell>
                    <TableCell>{j.missing ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Polled>
  );
}
