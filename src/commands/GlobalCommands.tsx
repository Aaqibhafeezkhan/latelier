import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../ThemeContext';
import { useSettings } from '../pages/SettingsContext';
import { useConnectionTransfer } from '../features/connections/ConnectionTransferProvider';
import { AuditLogModal } from '../pages/AuditLogModal';
import { ActivityLogModal } from '../pages/ActivityLogModal';
import { ShortcutsModal } from './ShortcutsModal';
import { useRegisterCommands } from './useRegisterCommands';

/**
 * Registers commands available from every route: theme toggle, settings,
 * the audit log, the activity log, the shortcuts cheat sheet, navigation
 * jumps, and `New connection`. Mount once near the App root, inside the
 * router and theme provider. Renders the audit log, activity log and
 * shortcuts modals itself, since nothing but these commands opens them.
 */
export function GlobalCommands() {
  const navigate = useNavigate();
  const [, toggleTheme] = useTheme();
  const settings = useSettings();
  const transfer = useConnectionTransfer();
  const [audit, setAudit] = useState<{ connectionId: string | null } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  // ⌘/ (Ctrl+/ elsewhere), ⌘N and ⌘, — the shortcuts these commands list.
  // A text field keeps ⌘/: CodeMirror binds it to toggle-comment, and typing a
  // slash must never open a dialog. In a field only ⌘ reaches ⌘N and ⌘,: a bare
  // Ctrl+N is macOS's next-line, CodeMirror's too. A dialog that is already open
  // keeps the keyboard from all three, like ⌘B and ⌘E.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== '/' && key !== 'n' && key !== ',') return;
      const origin = e.target instanceof HTMLElement ? e.target : null;
      if (origin?.closest('[role="dialog"], [role="alertdialog"]')) return;
      const inField = origin?.closest('input, textarea, select, [contenteditable]');
      if (inField && (key === '/' || !e.metaKey)) return;
      e.preventDefault();
      if (key === '/') setShortcutsOpen(true);
      else if (key === 'n') void navigate('/connections/new');
      else settings.open();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, settings]);

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
        shortcut: '⌘,',
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
        id: 'activity.open',
        title: 'Show activity log',
        group: 'general',
        keywords: ['notifications', 'errors', 'warnings', 'history'],
        perform: () => setActivityOpen(true),
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
            void navigate(`/connections/${ctx.connectionId}/edit`, { state: { returnTo: ctx.pathname } });
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
      {activityOpen && <ActivityLogModal onClose={() => setActivityOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}
