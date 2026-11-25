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

/** Approximate API price ratios, in plain-input-token equivalents. Not real prices. */
const WEIGHTS: TokenCounts = { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 };

const sum = (c: TokenCounts) => c.input + c.output + c.cacheRead + c.cacheCreation;
const weight = (c: TokenCounts) => KINDS.reduce((a, k) => a + c[k.key] * WEIGHTS[k.key], 0);
const n = (x: number) => x.toLocaleString();
/** The one display rule for a weight: a whole number. */
const w = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 0 });
const timeLabel = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const hourLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function bucketText(b: UsageBucket): string {
  const base = `${hourLabel(b.hour)}: weight ${w(weight(b))} (${n(sum(b))} tokens)`;
  return b.missing.length ? `${base}, missing data for ${b.missing.join(', ')}` : base;
}

/** Y ticks: 0 up to a round top at or above `max`, about four steps. */
function yTicks(max: number): number[] {
  const raw = Math.max(1, max) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** X ticks in local time: every 3 hours over a day, each midnight over a week, every 5th beyond. */
function xTicks(buckets: UsageBucket[]): { i: number; label: string }[] {
  const dates = buckets.map((b) => new Date(b.hour));
  if (buckets.length <= 24)
    return dates.flatMap((d, i) => (d.getHours() % 3 === 0 ? [{ i, label: timeLabel(d) }] : []));
  const nights = dates.flatMap((d, i) => (d.getHours() === 0 ? [{ i, label: dayLabel(d) }] : []));
  return buckets.length <= 168 ? nights : nights.filter((_, k) => k % 5 === 0);
}

/**
 * Stacked bars of weight, one per hour, each kind drawn at its weighted share; an hour with a
 * missing source is hatched and outlined, and says so. Axis text is HTML outside the stretched SVG.
 */
function Chart({
  buckets,
  fills,
  hatch,
}: {
  buckets: UsageBucket[];
  fills: string[];
  hatch: string;
}) {
  const { palette } = useTheme();
  const [active, setActive] = useState<number | null>(null);
  const W = 10;
  const HT = 160;
  const yt = yTicks(Math.max(0, ...buckets.map(weight)));
  const max = yt.at(-1) ?? 1;
  const pct = (i: number) => `${String(((i + 0.5) / buckets.length) * 100)}%`;
  const a = active === null ? undefined : buckets[active];
  const svg = (
    <svg
      viewBox={`0 0 ${String(buckets.length * W)} ${String(HT)}`}
      preserveAspectRatio="none"
      width="100%"
      height={HT}
      aria-label="Estimated cost weight per hour"
      role="group"
      onMouseLeave={() => {
        setActive(null);
      }}
    >
      {yt.map((t) => (
        <line
          key={t}
          x1={0}
          x2={buckets.length * W}
          y1={HT - (t / max) * HT}
          y2={HT - (t / max) * HT}
          stroke={palette.divider}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
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
        const show = () => {
          setActive(i);
        };
        return (
          <g
            key={b.hour}
            role="img"
            aria-label={text}
            tabIndex={0}
            onMouseEnter={show}
            onFocus={show}
            onBlur={() => {
              setActive(null);
            }}
          >
            <title>{text}</title>
            <rect
              x={i * W}
              y={0}
              width={W}
              height={HT}
              fill={active === i ? palette.action.hover : 'none'}
              pointerEvents="all"
            />
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
              const h = ((b[k.key] * WEIGHTS[k.key]) / max) * HT;
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
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        Weight (input-token equivalents)
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, mt: 1 }}>
        <Box sx={{ position: 'relative', height: HT, minWidth: 48 }} aria-label="Weight axis">
          {yt.map((t) => (
            <Typography
              key={t}
              variant="caption"
              color="text.secondary"
              sx={{
                position: 'absolute',
                right: 0,
                bottom: `${String((t / max) * 100)}%`,
                transform: 'translateY(50%)',
                lineHeight: 1,
              }}
            >
              {w(t)}
            </Typography>
          ))}
        </Box>
        {svg}
        <span />
        <Box sx={{ position: 'relative', height: 20 }} aria-label="Time axis">
          {xTicks(buckets).map((t) => (
            <Typography
              key={t.i}
              variant="caption"
              color="text.secondary"
              sx={{
                position: 'absolute',
                left: pct(t.i),
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </Typography>
          ))}
        </Box>
      </Box>
      <Box role="status" sx={{ minHeight: 24, mt: 0.5 }}>
        <Typography variant="body2" color={a ? 'text.primary' : 'text.secondary'}>
          {a
            ? `${hourLabel(a.hour)}: weight ${w(weight(a))}; ${KINDS.map(
                (k) => `${k.label.toLowerCase()} ${n(a[k.key])}`,
              ).join(', ')}${a.missing.length ? `; missing data for ${a.missing.join(', ')}` : ''}`
            : 'Hover over or focus an hour for its weight and counts.'}
        </Typography>
      </Box>
    </Box>
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
                <TableRow>
                  <TableCell component="th" scope="row">
                    Weight
                  </TableCell>
                  <TableCell align="right">{w(weight(data.total))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Weight is an estimated cost in input-token equivalents: input x {WEIGHTS.input} + cache
            creation x {WEIGHTS.cacheCreation} + cache read x {WEIGHTS.cacheRead} + output x{' '}
            {WEIGHTS.output}. The multipliers are approximate API price ratios, not a bill.
          </Typography>
          <Chart buckets={data.buckets} fills={fills} hatch={palette.error.main} />
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
            Hourly, local time. Hatched: a job&apos;s transcript could not be read.
          </Typography>
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
                  <TableCell align="right">Weight</TableCell>
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
                    <TableCell align="right">{w(weight(j))}</TableCell>
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
