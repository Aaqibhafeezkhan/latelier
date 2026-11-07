import React from 'react';
import { SettingsModal, type SettingsSection } from './SettingsModal';

interface SettingsApi {
  open: (section?: SettingsSection) => void;
}

const Ctx = React.createContext<SettingsApi>({ open: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): SettingsApi {
  return React.useContext(Ctx);
}

/**
 * Mounts the settings modal at App level so any route — including the
 * command palette — can open it without owning local state.
 */
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [opened, setOpened] = React.useState<{ section?: SettingsSection } | null>(null);
  const api = React.useMemo<SettingsApi>(() => ({ open: (section) => setOpened({ section }) }), []);
  return (
    <Ctx.Provider value={api}>
      {children}
      {opened && <SettingsModal initialSection={opened.section} onClose={() => setOpened(null)} />}
    </Ctx.Provider>
  );
}
