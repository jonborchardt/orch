// @vitest-environment jsdom
import type { Palette, Theme } from '@mui/material';
import { describe, expect, it } from 'vitest';

import { STATE } from './format.ts';
import { fonts, statusColor, theme, weight } from './theme.ts';

// Values captured from the theme on main before it moved out of main.tsx (ticket 0166): the move
// states MUI's defaults explicitly and must not change what the dashboard renders.
const PALETTE = {
  light: {
    primary: '#1976d2',
    error: '#d32f2f',
    warning: '#ed6c02',
    success: '#2e7d32',
    info: '#0288d1',
    text: 'rgba(0, 0, 0, 0.87)',
    background: '#fff',
  },
  dark: {
    primary: '#90caf9',
    error: '#f44336',
    warning: '#ffa726',
    success: '#66bb6a',
    info: '#29b6f6',
    text: '#fff',
    background: '#121212',
  },
} as const;

describe('dashboard theme', () => {
  it('resolves to the palette the dashboard has always rendered, light and dark', () => {
    // With cssVariables the resolved schemes exist at runtime; `Theme` does not type them.
    const schemes = (
      theme as Theme & { colorSchemes: Record<'light' | 'dark', { palette: Palette }> }
    ).colorSchemes;
    for (const mode of ['light', 'dark'] as const) {
      const p = schemes[mode].palette;
      const want = PALETTE[mode];
      expect({
        primary: p.primary.main,
        error: p.error.main,
        warning: p.warning.main,
        success: p.success.main,
        info: p.info.main,
        text: p.text.primary,
        background: p.background.default,
      }).toEqual(want);
    }
  });

  it('keeps the type scale, weights, spacing, and shape', () => {
    expect(theme.typography.fontSize).toBe(13);
    expect(theme.typography.fontFamily).toBe('system-ui, "Segoe UI", Roboto, sans-serif');
    expect(fonts.sans).toBe(theme.typography.fontFamily);
    expect(fonts.mono).toBe('monospace');
    expect(theme.typography.fontWeightRegular).toBe(400);
    expect(theme.typography.fontWeightMedium).toBe(500);
    expect(theme.typography.fontWeightBold).toBe(700);
    expect(weight).toEqual({ regular: 400, semibold: 600, bold: 700 });
    expect(theme.spacing(1)).toBe('var(--mui-spacing, 8px)');
    expect(theme.shape.borderRadius).toBe(4);
  });

  it('sets buttons, tabs, and toggles in sentence case', () => {
    expect(theme.typography.button.textTransform).toBe('none');
  });

  it('maps the four job states to the colours they have always had', () => {
    expect(statusColor).toEqual({
      needsHuman: 'error',
      running: 'primary',
      failed: 'error',
      completed: 'success',
    });
    expect(STATE.running.color).toBe('primary');
    expect(STATE.blocked.color).toBe('error');
    expect(STATE.failed.color).toBe('error');
    expect(STATE.completed.color).toBe('success');
  });
});
