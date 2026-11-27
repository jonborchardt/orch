import { CssBaseline, ThemeProvider } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { theme } from './theme.ts';

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
