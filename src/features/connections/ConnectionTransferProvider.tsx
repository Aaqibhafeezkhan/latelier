import React from 'react';
import { api } from '../../api/atelier';
import { ConnectionExportDialog } from './ConnectionExportDialog';
import { ImportWizard } from './importWizard/ImportWizard';

interface ConnectionTransferApi {
  openExport: () => void;
  openImport: () => void;
}

const Ctx = React.createContext<ConnectionTransferApi>({ openExport: () => {}, openImport: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useConnectionTransfer(): ConnectionTransferApi {
  return React.useContext(Ctx);
}

/**
 * Mounts the Connection Export dialog and the Import Wizard at App level so the command
 * palette, the native File menu and the empty screen can all open them.
 */
export function ConnectionTransferProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState<'export' | 'import' | null>(null);
  const value = React.useMemo<ConnectionTransferApi>(
    () => ({
      openExport: () => setOpen('export'),
      openImport: () => setOpen('import'),
    }),
    [],
  );
  React.useEffect(
    () =>
      api.app.onMenuCommand((command) => setOpen(command === 'connections.export' ? 'export' : 'import')),
    [],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {open === 'export' && <ConnectionExportDialog onClose={() => setOpen(null)} />}
      {open === 'import' && <ImportWizard initial="file" onClose={() => setOpen(null)} />}
    </Ctx.Provider>
  );
}
