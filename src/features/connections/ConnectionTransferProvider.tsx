import React from 'react';
import { api } from '../../api/atelier';
import { ConnectionExportDialog } from './ConnectionExportDialog';
import { ImportWizard } from './importWizard/ImportWizard';

interface ConnectionTransferApi {
  openExport: () => void;
  /** The Import Wizard, focused on its file source (default) or its paste box. */
  openImport: (initial?: 'file' | 'paste') => void;
  /** Whether this provider has a dialog on screen, so a dialog below it can leave Escape to it. */
  isOpen: boolean;
}

const Ctx = React.createContext<ConnectionTransferApi>({ openExport: () => {}, openImport: () => {}, isOpen: false });

// eslint-disable-next-line react-refresh/only-export-components
export function useConnectionTransfer(): ConnectionTransferApi {
  return React.useContext(Ctx);
}

type Open = 'export' | 'file' | 'paste';

/**
 * Mounts the Connection Export dialog and the one Import Wizard at App level so the command
 * palette, the native File menu, the empty screen and the Connections table can all open them.
 */
export function ConnectionTransferProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState<Open | null>(null);
  // An open wizard is never replaced: the native menu stays usable over it, and a
  // second wizard's file pick would clear the pending import main holds for this
  // one, while remounting would drop its review and the credentials typed there.
  const request = React.useCallback(
    (next: Open) => setOpen((cur) => (cur === 'file' || cur === 'paste' ? cur : next)),
    [],
  );
  const value = React.useMemo<ConnectionTransferApi>(
    () => ({
      openExport: () => request('export'),
      openImport: (initial = 'file') => request(initial),
      isOpen: open !== null,
    }),
    [request, open],
  );
  React.useEffect(
    () => api.app.onMenuCommand((command) => request(command === 'connections.export' ? 'export' : 'file')),
    [request],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {open === 'export' && <ConnectionExportDialog onClose={() => setOpen(null)} />}
      {(open === 'file' || open === 'paste') && <ImportWizard initial={open} onClose={() => setOpen(null)} />}
    </Ctx.Provider>
  );
}
