import React from 'react';
import { createHashRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import ConnectionManager from './pages/ConnectionManager';
import NewConnection from './pages/NewConnection';
import Workspace from './pages/Workspace';
import { HintsProvider } from './hints/HintsProvider';
import { SettingsProvider } from './pages/SettingsContext';
import { ConnectionTransferProvider } from './features/connections/ConnectionTransferProvider';
import { CommandPaletteRoot } from './commands/CommandPalette';
import { PaletteContextProvider } from './commands/PaletteContext';
import { GlobalCommands } from './commands/GlobalCommands';
import { ConnectionPaletteCommands } from './commands/ConnectionPaletteCommands';
import { TroubleshootingProvider } from './troubleshooting/TroubleshootingProvider';
import { TroubleshootingPaletteCommand } from './troubleshooting/TroubleshootingPaletteCommand';
import { UpdateReadyPrompt } from './features/updates/UpdateReadyPrompt';
import { Splash } from './components/Splash';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './ThemeContext';
import { mantineTheme } from './theme/mantineTheme';

const SPLASH_DURATION_MS = 800;

// Skip splash entirely under e2e harness — preload exposes a flag based on
// NODE_ENV=test + ATELIER_USER_DATA_DIR. Tests don't benefit from the
// 800ms cosmetic overlay and it shifts timings onto other animations.
const isTestEnv =
  typeof window !== 'undefined' &&
  (window as unknown as { __atelierEnv__?: { isTest?: boolean } }).__atelierEnv__?.isTest === true;

// A data router, not <HashRouter>: NewConnection's unsaved-changes guard uses
// `useBlocker`, which only works under one. The provider stack lives in the root
// layout route so every screen still sits inside the palette, settings and
// troubleshooting contexts.
function RootLayout() {
  return (
    <PaletteContextProvider>
      <SettingsProvider>
        <ConnectionTransferProvider>
          <CommandPaletteRoot>
            <TroubleshootingProvider>
              <GlobalCommands />
              <UpdateReadyPrompt />
              <ConnectionPaletteCommands />
              <TroubleshootingPaletteCommand />
              <ErrorBoundary>
                <Outlet />
              </ErrorBoundary>
            </TroubleshootingProvider>
          </CommandPaletteRoot>
        </ConnectionTransferProvider>
      </SettingsProvider>
    </PaletteContextProvider>
  );
}

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
