import { Outlet } from "react-router-dom";
import { SettingsProvider } from "./pages/SettingsContext";
import { ConnectionTransferProvider } from "./features/connections/ConnectionTransferProvider";
import { CommandPaletteRoot } from "./commands/CommandPalette";
import { PaletteContextProvider } from "./commands/PaletteContext";
import { GlobalCommands } from "./commands/GlobalCommands";
import { ConnectionPaletteCommands } from "./commands/ConnectionPaletteCommands";
import { TroubleshootingProvider } from "./troubleshooting/TroubleshootingProvider";
import { TroubleshootingPaletteCommand } from "./troubleshooting/TroubleshootingPaletteCommand";
import { UpdateReadyPrompt } from "./features/updates/UpdateReadyPrompt";
import { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * The root layout route: the provider stack every screen sits inside. Its own
 * file so a test can mount it without the module-level router in App.tsx.
 */
export function RootLayout() {
  // The outer boundary catches a provider that fails to render (the router would
  // otherwise show its own default error page). The inner one, around the
  // routed screen, keeps the providers and the palette alive when only a screen fails.
  return (
    <ErrorBoundary>
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
    </ErrorBoundary>
  );
}
