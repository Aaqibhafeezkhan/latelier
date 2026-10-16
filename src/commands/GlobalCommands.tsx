import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../ThemeContext';
import { useSettings } from '../pages/SettingsContext';
import { useConnectionTransfer } from '../features/connections/ConnectionTransferProvider';
import { AuditLogModal } from '../pages/AuditLogModal';
import { ShortcutsModal } from './ShortcutsModal';
import { useRegisterCommands } from './useRegisterCommands';

/**
 * Registers commands available from every route: theme toggle, settings,
 * the audit log, the shortcuts cheat sheet, navigation jumps, and `New
 * connection`. Mount once near the App root, inside the router and theme
 * provider. Renders the audit log and shortcuts modals itself, since nothing
 * but these commands opens them.
 */
export function GlobalCommands() {
  const navigate = useNavigate();
  const [, toggleTheme] = useTheme();
  const settings = useSettings();
  const transfer = useConnectionTransfer();
  const [audit, setAudit] = useState<{ connectionId: string | null } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // ⌘/ (Ctrl+/ elsewhere). A text field or editor keeps it: CodeMirror binds it
  // to toggle-comment, and typing a slash must never open a dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const origin = e.target instanceof HTMLElement ? e.target : null;
      // Like ⌘B and ⌘E: a dialog that is already open keeps the keyboard.
      if (origin?.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (origin?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useRegisterCommands(
    [
      {
        id: 'theme.toggle',
        title: 'Toggle dark mode',
        group: 'general',
        keywords: ['theme', 'dark', 'light'],
        perform: () => toggleTheme(),
      },
      {
        id: 'settings.open',
        title: 'Open settings',
        group: 'general',
        keywords: ['preferences', 'config'],
        perform: () => settings.open(),
      },
      {
        id: 'audit.open',
        title: 'Open audit log',
        group: 'general',
        keywords: ['history', 'operations', 'changes'],
        perform: (ctx) => setAudit({ connectionId: ctx.connectionId }),
      },
      {
        id: 'help.shortcuts',
        title: 'Keyboard shortcuts…',
        group: 'general',
        keywords: ['keys', 'hotkeys', 'cheat sheet', 'help'],
        shortcut: '⌘/',
        perform: () => setShortcutsOpen(true),
      },
      {
        id: 'nav.workspace',
        title: 'Go to workspace',
        group: 'navigation',
        keywords: ['tabs', 'query'],
        // `connectionId` falls back to the Focused Tab's Connection off the deep
        // screen, so this also offers the jump from the Data View's
        // own empty state once a Connection exists — not just from
        // `/connections/:id`.
        when: (ctx) => ctx.pathname !== '/workspace' && ctx.connectionId !== null,
        perform: () => navigate('/workspace'),
      },
      {
        id: 'connection.new',
        title: 'New connection',
        group: 'connection',
        keywords: ['add', 'create'],
        shortcut: '⌘N',
        perform: () => navigate('/connections/new'),
      },
      {
        id: 'connection.export',
        title: 'Export Connections…',
        group: 'connection',
        keywords: ['backup', 'file', 'transfer', 'save'],
        perform: () => transfer.openExport(),
      },
      {
        id: 'connection.import',
        title: 'Import Connections…',
        group: 'connection',
        keywords: ['restore', 'file', 'transfer', 'load'],
        perform: () => transfer.openImport(),
      },
      {
        id: 'connection.edit',
        title: 'Edit selected connection',
        group: 'connection',
        keywords: ['modify'],
        // `connectionId` falls back to the Focused Tab's Connection off the deep
        // screen, so this is now also reachable from the Data View —
        // pass `returnTo` so saving/canceling lands back where the command
        // was invoked from, not always on the deep screen it used to be the
        // only way to reach this from.
        when: (ctx) => ctx.connectionId !== null,
        perform: (ctx) => {
          if (ctx.connectionId) {
            navigate(`/connections/${ctx.connectionId}/edit`, { state: { returnTo: ctx.pathname } });
          }
        },
      },
    ],
    [navigate, toggleTheme, settings, transfer],
  );

  return (
    <>
      {audit && (
        <AuditLogModal initialConnectionId={audit.connectionId} onClose={() => setAudit(null)} />
      )}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}
