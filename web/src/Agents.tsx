import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import type {
  AgentsView,
  AgentTiming,
  AuthorTotalRow,
  BuilderModelRow,
  ChallengerModelRow,
  ReviewerModelRow,
  ReviewerRow,
  StageRow,
} from '../../src/server/types.ts';
import { duration, Polled, UNAVAILABLE, usePolled } from './Runs.tsx';
import { fetchAgents } from './api.ts';

type Row = AgentTiming & { role: string; runs: number };

/** A count with its share of Runs; no share when there are no runs. */
const share = (n: number, runs: number) =>
  runs === 0 ? String(n) : `${String(n)} (${String(Math.round((n / runs) * 100))}%)`;

const REVIEWER_COLUMNS: [string, (r: ReviewerRow) => string][] = [
  ['Pass', (r) => String(r.pass)],
  ['Changes', (r) => share(r.changes, r.runs)],
];

const STAGE_COLUMNS: [string, (r: StageRow) => string][] = [
  ['Completed', (r) => String(r.completed)],
  ['Failed', (r) => String(r.failed)],
  ['Escalated', (r) => String(r.escalated)],
  ['Sent back', (r) => String(r.sentBack)],
  ['Cancelled', (r) => String(r.cancelled)],
  ['Interrupted', (r) => String(r.interrupted)],
];

function AgentTable<R extends Row>({
  label,
  rows,
  columns,
  note,
}: {
  label: string;
  rows: R[];
  columns: [string, (r: R) => string][];
  note?: string;
}) {
  const unmeasured = rows.filter((r) => r.unmeasured > 0);
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" component="h2">
        {label}
      </Typography>
      <TableContainer>
        <Table size="small" aria-label={label}>
          <TableHead>
            <TableRow>
              <TableCell>Role</TableCell>
              <TableCell align="right">Runs</TableCell>
              {columns.map(([name]) => (
                <TableCell key={name} align="right">
                  {name}
                </TableCell>
              ))}
              <TableCell align="right">Average</TableCell>
              <TableCell align="right">Median</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.role}>
                <TableCell component="th" scope="row">
                  {r.role}
                </TableCell>
                <TableCell align="right">{String(r.runs)}</TableCell>
                {columns.map(([name, cell]) => (
                  <TableCell key={name} align="right">
                    {cell(r)}
                  </TableCell>
                ))}
                <TableCell align="right">{duration(r.averageMs)}</TableCell>
                <TableCell align="right">{duration(r.medianMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {note && (
        <Typography variant="caption" color="text.secondary" component="p">
          {note}
        </Typography>
      )}
      {unmeasured.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p">
          Runs without a duration, left out of Average and Median:{' '}
          {unmeasured.map((r) => `${r.role} ${String(r.unmeasured)}`).join(', ')}.
        </Typography>
      )}
    </Box>
  );
}

const percent = (r: number | null) =>
  r === null ? UNAVAILABLE : `${String(Math.round(r * 100))}%`;
const mean = (x: number | null) => (x === null ? UNAVAILABLE : String(Math.round(x * 100) / 100));
const model = (m: string | null) => m ?? 'not recorded';
const author = (same: boolean | null) => (same === null ? 'n/a' : same ? 'same' : 'different');
const objections = (r: { objections: number; objectionRate: number | null }) =>
  `${String(r.objections)} (${percent(r.objectionRate)})`;

const MODEL_COLUMNS: [string, (r: ChallengerModelRow) => string][] = [
  ['Role', (r) => r.role],
  ['Model', (r) => model(r.model)],
  ['Author model', (r) => author(r.sameAsAuthor)],
  ['Reviews', (r) => String(r.reviews)],
  ['Objections', objections],
];

const REVIEWER_MODEL_COLUMNS: [string, (r: ReviewerModelRow) => string][] = [
  ...MODEL_COLUMNS,
  ['Only objector', (r) => String(r.onlyObjector)],
  ['Real catches', (r) => String(r.realCatches)],
  ['Fixed, changes again', (r) => String(r.fixed)],
  ['Unresolved', (r) => String(r.unresolved)],
  [
    'False alarms',
    ({ falseAlarms: f }) =>
      `${String(f.total)} (declined ${String(f.declined)}, overruled ${String(f.overruled)}, vanished ${String(f.vanished)})`,
  ],
  [
    'Escapes',
    ({ escapes: e }) =>
      `${String(e.total)} (CI repair ${String(e.ciRepair)}, bug ${String(e.bug)}, revert ${String(e.revert)})`,
  ],
  ['Median', (r) => duration(r.medianMs)],
];

const BUILDER_MODEL_COLUMNS: [string, (r: BuilderModelRow) => string][] = [
  ['Role', (r) => r.role],
  ['Model', (r) => model(r.model)],
  ['Jobs', (r) => String(r.jobs)],
  ['First-pass verification', (r) => percent(r.firstPassRate)],
  ['Review rounds', (r) => mean(r.meanRounds)],
  ['CI repairs', (r) => mean(r.meanCiRepairs)],
  ['Escalations', (r) => mean(r.escalationsPerJob)],
  [
    'Tokens per job',
    (r) =>
      r.meanTokens === null
        ? UNAVAILABLE
        : `${Math.round(r.meanTokens).toLocaleString('en-US')} (${String(r.tokenJobs)} of ${String(r.jobs)} jobs)`,
  ],
];

const AUTHOR_COLUMNS: [string, (r: AuthorTotalRow) => string][] = [
  ['Role', (r) => r.role],
  ['Author model', (r) => author(r.sameAsAuthor)],
  ['Reviews', (r) => String(r.reviews)],
  ['Objections', objections],
];

/** A per-model table: one row per key, every cell a string. */
function ModelTable<R>({
  label,
  rows,
  columns,
  notes = [],
}: {
  label: string;
  rows: R[];
  columns: [string, (r: R) => string][];
  notes?: string[];
}) {
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" component="h2">
        {label}
      </Typography>
      <TableContainer>
        <Table size="small" aria-label={label}>
          <TableHead>
            <TableRow>
              {columns.map(([name], i) => (
                <TableCell key={name} align={i === 0 ? 'left' : 'right'}>
                  {name}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length}>No runs yet.</TableCell>
              </TableRow>
            )}
            {rows.map((r, k) => (
              <TableRow key={k}>
                {columns.map(([name, cell], i) =>
                  i === 0 ? (
                    <TableCell key={name} component="th" scope="row">
                      {cell(r)}
                    </TableCell>
                  ) : (
                    <TableCell key={name} align="right">
                      {cell(r)}
                    </TableCell>
                  ),
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {notes.map((n) => (
        <Typography key={n} variant="caption" color="text.secondary" component="p">
          {n}
        </Typography>
      ))}
    </Box>
  );
}

function ByModel({ data }: { data: AgentsView }) {
  return (
    <>
      <ModelTable
        label="Reviewers by model"
        rows={data.byModel.reviewers}
        columns={REVIEWER_MODEL_COLUMNS}
        notes={[
          'Findings count attributed blocking findings each reviewer raised; open ones and rounds consolidated before attribution are left out.',
          'Escapes count a revert only when a ticket titled "revert" names the job or its PR: orch records no Git revert.',
          "Tokens per review are not measured: a session's tokens are recorded per job, not per agent.",
        ]}
      />
      <ModelTable
        label="Spec challenger by model"
        rows={data.byModel.challengers}
        columns={MODEL_COLUMNS}
      />
      <ModelTable
        label="Same or different model as the author"
        rows={data.byModel.authorTotals}
        columns={AUTHOR_COLUMNS}
      />
      <ModelTable
        label="Builders by model"
        rows={data.byModel.builders}
        columns={BUILDER_MODEL_COLUMNS}
        notes={[
          "Tokens are whole-job (every agent in the job) under the role's drawn model, over jobs with recorded sessions.",
        ]}
      />
      <Box sx={{ mb: 3 }}>
        <Typography variant="subtitle1" component="h2">
          Notes
        </Typography>
        {data.notes.length === 0 ? (
          <Typography variant="body2">No notes yet.</Typography>
        ) : (
          <ul aria-label="Model notes">
            {data.notes.map((n) => (
              <li key={n.text}>
                <Typography variant="body2" component="span">
                  {n.text} (n={String(n.n)}, {n.confidence} confidence)
                </Typography>
              </li>
            ))}
          </ul>
        )}
        <Typography variant="caption" color="text.secondary" component="p">
          Notes follow fixed rules over the numbers above; they advise, and nothing in orch changes
          a pool.
        </Typography>
      </Box>
    </>
  );
}

export function AgentsPage({ refreshMs = 4000 }: { refreshMs?: number }) {
  const { data, error } = usePolled(fetchAgents, refreshMs);
  return (
    <Polled label="Agents" error={error} loaded={data !== null}>
      <AgentTable label="Reviewers" rows={data?.reviewers ?? []} columns={REVIEWER_COLUMNS} />
      <AgentTable
        label="Stages"
        rows={data?.stages ?? []}
        columns={STAGE_COLUMNS}
        note="Stage time includes coordinator work."
      />
      {data && <ByModel data={data} />}
    </Polled>
  );
}
