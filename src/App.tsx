import React from 'react';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import { RootLayout } from './RootLayout';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import ConnectionManager from './pages/ConnectionManager';
import NewConnection from './pages/NewConnection';
import Workspace from './pages/Workspace';
import { HintsProvider } from './hints/HintsProvider';
import { Splash } from './components/Splash';
import {
  applyEditorFontSize,
  EDITOR_FONT_SIZE_PREF_KEY,
  isEditorFontSize,
  useTheme,
} from './ThemeContext';
import { api, getErrorMessage } from './api/atelier';
import { notify } from './theme/notifications';
import { mantineTheme } from './theme/mantineTheme';

const SPLASH_DURATION_MS = 800;

// Skip splash entirely under e2e harness — preload exposes a flag based on
// NODE_ENV=test + ATELIER_USER_DATA_DIR. Tests don't benefit from the
// 800ms cosmetic overlay and it shifts timings onto other animations.
const isTestEnv =
  typeof window !== 'undefined' &&
  (window as unknown as { __atelierEnv__?: { isTest?: boolean } }).__atelierEnv__?.isTest === true;

// A data router, not <HashRouter>: NewConnection's unsaved-changes guard uses
// `useBlocker`, which only works under one. The provider stack lives in the
// root layout route (RootLayout) so every screen still sits inside it.
const router = createHashRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <Navigate to="/workspace" replace /> },
      // Retired list-sidebar screen — the Switcher is how users reach
      // Connections now; send any old bookmark home.
      { path: '/connections', element: <Navigate to="/workspace" replace /> },
      { path: '/connections/:id', element: <ConnectionManager /> },
      { path: '/connections/new', element: <NewConnection /> },
      { path: '/connections/:id/edit', element: <NewConnection /> },
      // Legacy route, redirect for any bookmarks
      { path: '/new-connection', element: <Navigate to="/connections/new" replace /> },
      { path: '/workspace', element: <Workspace /> },
      // Aggregation lives inside /workspace as a tab kind (A01).
      { path: '/aggregation', element: <Navigate to="/workspace" replace /> },
    ],
  },
]);

// Vite re-evaluates this module on a hot update; drop the old router's listeners.
if (import.meta.hot) import.meta.hot.dispose(() => router.dispose());

export default function App() {
  const [splashVisible, setSplashVisible] = React.useState(!isTestEnv);
  React.useEffect(() => {
    if (isTestEnv) return;
    const t = window.setTimeout(() => setSplashVisible(false), SPLASH_DURATION_MS);
    return () => window.clearTimeout(t);
  }, []);
  // X12 Phase 0: drive Mantine's color scheme from the existing useTheme()
  // hook so Mantine and the legacy themeVars stay in lockstep. Routes keep their
  // own useTheme() calls; they share state via api.prefs broadcasts.
  const [dark] = useTheme();
  // The editor font size is read once at boot; Settings applies changes live.
  React.useEffect(() => {
    api.prefs
      .get<number>(EDITOR_FONT_SIZE_PREF_KEY)
      .then((v) => {
        if (isEditorFontSize(v)) applyEditorFontSize(v);
      })
      .catch((err) => {
        notify.error(getErrorMessage(err, 'Could not read the editor font size.'), {
          id: 'editor-font-size-read-failed',
        });
      });
  }, []);
  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={dark ? 'dark' : 'light'}>
      <ModalsProvider>
        <Notifications position="bottom-right" />
        <HintsProvider>
          {splashVisible && <Splash />}
          <RouterProvider router={router} />
        </HintsProvider>
      </ModalsProvider>
    </MantineProvider>
  );
}
