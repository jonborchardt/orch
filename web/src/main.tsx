import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

/** Compact developer-tool theme with native light and dark schemes (following the OS). */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data' },
  colorSchemes: { light: true, dark: true },
  typography: { fontSize: 13, fontFamily: 'system-ui, "Segoe UI", Roboto, sans-serif' },
  components: {
    MuiTableCell: { styleOverrides: { root: { padding: '4px 8px' } } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiButton: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small' } },
  },
});

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <ThemeProvider theme={theme} defaultMode="system">
        <CssBaseline />
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
