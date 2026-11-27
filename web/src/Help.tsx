import { Box, Button, Popover, Typography } from '@mui/material';
import { type ReactNode, useState } from 'react';

import type { Liveness, StepId } from '../../src/server/types.ts';
import { STATE } from './format.ts';

/**
 * The workflow steps as `STEPS` in `src/server/status.ts` labels them (web/ cannot import it);
 * keyed by `StepId` so a new step fails the typecheck here.
 */
const STAGES: Record<StepId, string> = {
  spec: 'Spec',
  build: 'Build',
  simplify: 'Simplify',
  review: 'Review',
  approve: 'Approve',
  pr: 'PR',
  ci: 'CI',
  done: 'Done',
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" component="h2">
        {title}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

/** The app bar's `?`: a short glossary of orch's terms, the same on every section. */
export function Help({ refreshMs }: { refreshMs: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        aria-label="Help"
        color="inherit"
        size="small"
        sx={{ minWidth: 0 }}
        onClick={(e) => {
          setAnchor(e.currentTarget);
        }}
      >
        ?
      </Button>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { role: 'dialog', 'aria-label': 'Help', sx: { p: 2, maxWidth: 480 } },
        }}
      >
        <Typography variant="body2" color="text.secondary">
          The dashboard re-reads the shared orch database every {String(refreshMs / 1000)}s.
        </Typography>
        <Group title="Stages">
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {Object.entries(STAGES).map(([id, label]) => (
              <li key={id}>{label}</li>
            ))}
          </Box>
          needs human is a pause in the stage a job stopped at, not a stage of its own.
        </Group>
        <Group title="Statuses">
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {(Object.entries(STATE) as [Liveness, (typeof STATE)[Liveness]][]).map(([k, s]) => (
              <li key={k}>
                {s.glyph} {s.label}: {s.describe}
              </li>
            ))}
          </Box>
        </Group>
        <Group title="Leases and stale">
          A session owns a job through a lease it renews while it works. A live lease is not proof
          that a process is alive right now. Stale means the lease lapsed without renewal while the
          job still reads running.
        </Group>
        <Group title="Review rounds and CI repairs">
          Round r of max counts review rounds: when the last allowed round still asks for changes,
          the job escalates to needs human. Repairs n of max counts CI failures sent back to build:
          when that budget is spent, the job escalates to needs human too.
        </Group>
        <Group title="What the dashboard does not do">
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            <li>Start, stop, or resume the factory controller; that is the CLI.</li>
            <li>Message or steer a Claude session.</li>
            <li>Skip a gate, or merge without verification.</li>
            <li>Decide for you: a needs-human job waits for a person.</li>
          </Box>
        </Group>
      </Popover>
    </>
  );
}
