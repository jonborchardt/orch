import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * Just enough Markdown for factory artifacts: headings, bullet and numbered lists, fenced code,
 * paragraphs, and the VERDICT / DECISION / BLOCKING marker lines. No HTML is ever interpreted.
 */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  let key = 0;
  const push = (node: ReactNode) => out.push(<Box key={key++}>{node}</Box>);
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '');
      i++;
      push(
        <Box
          component="pre"
          sx={{
            m: 0,
            my: 1,
            p: 1,
            borderRadius: 1,
            bgcolor: 'action.hover',
            overflowX: 'auto',
            fontSize: 12,
          }}
        >
          {code.join('\n')}
        </Box>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      push(
        <Typography
          variant={level <= 1 ? 'h6' : level === 2 ? 'subtitle1' : 'subtitle2'}
          sx={{ mt: level <= 2 ? 2 : 1, fontWeight: 600 }}
        >
          {heading[2]}
        </Typography>,
      );
      i++;
      continue;
    }
    const marker = /^(VERDICT|DECISION|BLOCKING):\s*(\S+)\s*$/.exec(line);
    if (marker) {
      push(
        <Typography
          component="p"
          sx={{ fontFamily: 'monospace', fontWeight: 700, mt: 1 }}
          data-marker={marker[1]}
        >
          {marker[1]}: {marker[2]}
        </Typography>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+[.)]/.test(line);
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*]|\d+[.)])\s+/, ''));
        i++;
        // continuation lines indented under the item
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? '') &&
          !/^\s*([-*]|\d+[.)])\s+/.test(lines[i] ?? '')
        ) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${(lines[i] ?? '').trim()}`;
          i++;
        }
      }
      push(
        <Box component={ordered ? 'ol' : 'ul'} sx={{ my: 0.5, pl: 3 }}>
          {items.map((it, n) => (
            <li key={n}>
              <Inline text={it} />
            </li>
          ))}
        </Box>,
      );
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,6}\s|```|\s*([-*]|\d+[.)])\s+|(VERDICT|DECISION|BLOCKING):)/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    push(
      <Typography component="p" sx={{ my: 0.5, whiteSpace: 'pre-wrap' }}>
        <Inline text={para.join('\n')} />
      </Typography>,
    );
  }
  return <Box sx={{ wordBreak: 'break-word' }}>{out}</Box>;
}

/** Inline code spans and bold. Everything else is plain text. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, n) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 1) {
          return (
            <Box
              key={n}
              component="code"
              sx={{ px: 0.5, borderRadius: 0.5, bgcolor: 'action.hover', fontSize: '0.92em' }}
            >
              {p.slice(1, -1)}
            </Box>
          );
        }
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
          return <strong key={n}>{p.slice(2, -2)}</strong>;
        }
        return p;
      })}
    </>
  );
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const MARKER = /^(VERDICT|DECISION|BLOCKING):/;

/**
 * The body of the section under the heading named `name`, up to the next heading of the same or a
 * higher level, without marker lines; null when there is no such heading.
 */
export function section(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => HEADING.exec(l)?.[2] === name);
  if (at < 0) return null;
  const level = HEADING.exec(lines[at] ?? '')?.[1]?.length ?? 1;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const h = HEADING.exec(line);
    if (h && (h[1]?.length ?? 1) <= level) break;
    if (!MARKER.test(line)) body.push(line);
  }
  return body.join('\n').trim();
}

/** The lines tagged `[BLOCKING]`, each with the indented continuation lines under it. */
export function blockingLines(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('[BLOCKING]')) {
      out.push(line);
      open = true;
    } else if (open && /^\s{2,}\S/.test(line) && !/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}\n${line}`;
    } else {
      open = false;
    }
  }
  return out;
}
