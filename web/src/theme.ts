import { createTheme } from '@mui/material';

/**
 * The dashboard's one source of colour, type, spacing, and shape. Components take values from here
 * (palette role names, `typography`, `spacing`, or the exports below) and never add their own.
 * The values are MUI's defaults as the dashboard has always rendered them, stated so later work
 * changes them in one place.
 */

export const fonts = {
  sans: 'system-ui, "Segoe UI", Roboto, sans-serif',
  mono: 'monospace',
} as const;

/** The three weights in use. MUI has no 600 token (its `fontWeightMedium` is 500). */
export const weight = { regular: 400, semibold: 600, bold: 700 } as const;

/** Sizes outside the typography variants: code blocks, the progress line, inline code. */
export const textSize = { code: '12px', progress: '0.875rem', inlineCode: '0.92em' } as const;

/** The one mapping from a job's state to its colour (a palette role). */
export const statusColor = {
  needsHuman: 'error',
  running: 'primary',
  failed: 'error',
  completed: 'success',
} as const;

/** Compact developer-tool theme with native light and dark schemes (following the OS). */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data' },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#1976d2', light: '#42a5f5', dark: '#1565c0' },
        secondary: { main: '#9c27b0', light: '#ba68c8', dark: '#7b1fa2' },
        error: { main: '#d32f2f', light: '#ef5350', dark: '#c62828' },
        warning: { main: '#ed6c02', light: '#ff9800', dark: '#e65100' },
        info: { main: '#0288d1', light: '#03a9f4', dark: '#01579b' },
        success: { main: '#2e7d32', light: '#4caf50', dark: '#1b5e20' },
        text: {
          primary: 'rgba(0, 0, 0, 0.87)',
          secondary: 'rgba(0, 0, 0, 0.6)',
          disabled: 'rgba(0, 0, 0, 0.38)',
        },
        background: { default: '#fff', paper: '#fff' },
        divider: 'rgba(0, 0, 0, 0.12)',
      },
    },
    dark: {
      palette: {
        primary: { main: '#90caf9', light: '#e3f2fd', dark: '#42a5f5' },
        secondary: { main: '#ce93d8', light: '#f3e5f5', dark: '#ab47bc' },
        error: { main: '#f44336', light: '#e57373', dark: '#d32f2f' },
        warning: { main: '#ffa726', light: '#ffb74d', dark: '#f57c00' },
        info: { main: '#29b6f6', light: '#4fc3f7', dark: '#0288d1' },
        success: { main: '#66bb6a', light: '#81c784', dark: '#388e3c' },
        text: {
          primary: '#fff',
          secondary: 'rgba(255, 255, 255, 0.7)',
          disabled: 'rgba(255, 255, 255, 0.5)',
        },
        background: { default: '#121212', paper: '#121212' },
        divider: 'rgba(255, 255, 255, 0.12)',
      },
    },
  },
  typography: {
    fontSize: 13,
    htmlFontSize: 16,
    fontFamily: fonts.sans,
    fontWeightRegular: weight.regular,
    fontWeightMedium: 500,
    fontWeightBold: weight.bold,
    button: { textTransform: 'none' },
  },
  spacing: 8,
  shape: { borderRadius: 4 },
  components: {
    MuiTableCell: { styleOverrides: { root: { padding: '4px 8px' } } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiButton: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small' } },
  },
});
