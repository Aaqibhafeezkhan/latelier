import React from 'react';
import { Button, Group, Modal, SegmentedControl, Select, Stack, Switch, Text } from '@mantine/core';
import { useHints } from '../hints/HintsContext';
import { api, getErrorMessage } from '../api/atelier';
import { invalidateRecentValuesCache } from '../features/fieldSuggestions/sources';
import { notify } from '../theme/notifications';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import {
  applyEditorFontSize,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_FONT_SIZE_PREF_KEY,
  isEditorFontSize,
  useThemeMode,
  type ThemeMode,
} from '../ThemeContext';
import {
  DEFAULT_PAGE_SIZE_PREF_KEY,
  DEFAULT_VIEW_PREF_KEY,
  PAGE_SIZE_OPTIONS,
  RESULT_VIEW_OPTIONS,
} from '../state/workspaceTabs';
import type { ResultViewMode } from '@shared/types';

const RESTORE_TABS_KEY = 'ui.workspace.restoreTabs';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const PAGE_SIZE_SELECT_DATA = PAGE_SIZE_OPTIONS.map(String);
const FONT_SIZE_SELECT_DATA = Array.from(
  { length: EDITOR_FONT_SIZE_MAX - EDITOR_FONT_SIZE_MIN + 1 },
  (_, i) => String(EDITOR_FONT_SIZE_MIN + i),
);

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { reset } = useHints();
  const close = useDialogFocusReturn(onClose);
  const [resetting, setResetting] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [clearingValues, setClearingValues] = React.useState(false);

  // Unset means restore, so the switch starts on.
  const [restoreTabs, setRestoreTabs] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    api.prefs
      .get<boolean>(RESTORE_TABS_KEY)
      .then((v) => {
        if (!cancelled) setRestoreTabs(v !== false);
      })
      .catch((err) => notify.error(getErrorMessage(err, 'Failed to read the tab restore setting.')));
    return () => {
      cancelled = true;
    };
  }, []);

  // Null until main answers; the row stays hidden rather than guess.
  const [columnKeyProtected, setColumnKeyProtected] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api.secrets
      .status()
      .then(({ columnKeyProtected: isProtected }) => {
        if (!cancelled) setColumnKeyProtected(isProtected);
      })
      .catch((err) => notify.error(getErrorMessage(err, 'Failed to read the local data protection status.')));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRestoreTabs = async (next: boolean) => {
    setRestoreTabs(next);
    try {
      await api.prefs.set(RESTORE_TABS_KEY, next);
    } catch (err) {
      setRestoreTabs(!next);
      notify.error(getErrorMessage(err, 'Failed to save the tab restore setting.'));
    }
  };

  const [themeMode, setThemeMode] = useThemeMode();

  // Unset values show the defaults the app applies: 50 rows, Tree, 13px.
  const [pageSize, setPageSize] = React.useState<number>(50);
  const [view, setView] = React.useState<ResultViewMode>('Tree');
  const [fontSize, setFontSize] = React.useState<number>(13);

  React.useEffect(() => {
    let cancelled = false;
    const fail = (err: unknown, what: string) =>
      notify.error(getErrorMessage(err, `Failed to read the ${what} setting.`));
    api.prefs
      .get<number>(DEFAULT_PAGE_SIZE_PREF_KEY)
      .then((v) => {
        if (!cancelled && typeof v === 'number' && (PAGE_SIZE_OPTIONS as readonly number[]).includes(v)) {
          setPageSize(v);
        }
      })
      .catch((err) => fail(err, 'default page size'));
    api.prefs
      .get<string>(DEFAULT_VIEW_PREF_KEY)
      .then((v) => {
        if (!cancelled && (RESULT_VIEW_OPTIONS as readonly unknown[]).includes(v)) {
          setView(v as ResultViewMode);
        }
      })
      .catch((err) => fail(err, 'default result view'));
    api.prefs
      .get<number>(EDITOR_FONT_SIZE_PREF_KEY)
      .then((v) => {
        if (!cancelled && isEditorFontSize(v)) setFontSize(v);
      })
      .catch((err) => fail(err, 'editor font size'));
    return () => {
      cancelled = true;
    };
  }, []);

  const savePref = async <T,>(key: string, next: T, prev: T, revert: (v: T) => void, what: string) => {
    try {
      await api.prefs.set(key, next);
    } catch (err) {
      revert(prev);
      notify.error(getErrorMessage(err, `Failed to save the ${what} setting.`));
    }
  };

  const handlePageSize = (value: string | null) => {
    const next = Number.parseInt(value ?? '', 10);
    if (!(PAGE_SIZE_OPTIONS as readonly number[]).includes(next)) return;
    const prev = pageSize;
    setPageSize(next);
    void savePref(DEFAULT_PAGE_SIZE_PREF_KEY, next, prev, setPageSize, 'default page size');
  };

  const handleView = (value: string) => {
    const next = value as ResultViewMode;
    const prev = view;
    setView(next);
    void savePref(DEFAULT_VIEW_PREF_KEY, next, prev, setView, 'default result view');
  };

  const handleFontSize = (value: string | null) => {
    const next = Number.parseInt(value ?? '', 10);
    if (!isEditorFontSize(next)) return;
    const prev = fontSize;
    setFontSize(next);
    applyEditorFontSize(next);
    void savePref(
      EDITOR_FONT_SIZE_PREF_KEY,
      next,
      prev,
      (v) => {
        setFontSize(v);
        applyEditorFontSize(v);
      },
      'editor font size',
    );
  };

  const handleResetHints = () => {
    setResetting(true);
    reset();
    notify.success("Hints reset — you'll see them again as you use the app.");
    setResetting(false);
  };

  const handleClearValueHistory = async () => {
    setClearingValues(true);
    try {
      await api.recent.clearFieldValues();
      invalidateRecentValuesCache();
      notify.success('Value history cleared.');
    } catch (err) {
      notify.error(getErrorMessage(err, 'Failed to clear value history.'));
    } finally {
      setClearingValues(false);
    }
  };

  const handleExportDiagnostic = async () => {
    setExporting(true);
    try {
      const { path } = await api.app.diagnosticBundle();
      if (path) {
        notify.success(`Saved to ${path}`, { title: 'Diagnostic bundle exported' });
      }
    } catch (err) {
      notify.error(getErrorMessage(err, 'Failed to export bundle.'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal opened onClose={close} title="Settings" centered size="md">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Theme
            </Text>
            <Text size="xs" c="dimmed">
              System follows the operating system's appearance.
            </Text>
          </Stack>
          <SegmentedControl
            size="xs"
            aria-label="Theme"
            data={THEME_OPTIONS}
            value={themeMode}
            onChange={(v) => setThemeMode(v as ThemeMode)}
          />
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Default page size
            </Text>
            <Text size="xs" c="dimmed">
              Rows per page in a collection tab opened from now on.
            </Text>
          </Stack>
          <Select
            size="xs"
            w={90}
            aria-label="Default page size"
            allowDeselect={false}
            data={PAGE_SIZE_SELECT_DATA}
            value={String(pageSize)}
            onChange={handlePageSize}
          />
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Default result view
            </Text>
            <Text size="xs" c="dimmed">
              How a collection tab opened from now on shows its documents.
            </Text>
          </Stack>
          <SegmentedControl
            size="xs"
            aria-label="Default result view"
            data={[...RESULT_VIEW_OPTIONS]}
            value={view}
            onChange={handleView}
          />
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Editor font size
            </Text>
            <Text size="xs" c="dimmed">
              Script tab, aggregation stage bodies and the document editor, in pixels.
            </Text>
          </Stack>
          <Select
            size="xs"
            w={90}
            aria-label="Editor font size"
            allowDeselect={false}
            data={FONT_SIZE_SELECT_DATA}
            value={String(fontSize)}
            onChange={handleFontSize}
          />
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Reopen tabs on launch
            </Text>
            <Text id="restore-tabs-description" size="xs" c="dimmed">
              When off, the app starts with no tabs open, pinned ones included, and pipeline
              changes that were never saved are lost with them.
            </Text>
          </Stack>
          <Switch
            aria-label="Reopen tabs on launch"
            aria-describedby="restore-tabs-description"
            checked={restoreTabs}
            onChange={(e) => void handleRestoreTabs(e.currentTarget.checked)}
          />
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Hints
            </Text>
            <Text size="xs" c="dimmed">
              Re-enable contextual tips you've dismissed.
            </Text>
          </Stack>
          <Button
            variant="default"
            size="compact-xs"
            onClick={handleResetHints}
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : 'Reset hints'}
          </Button>
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Diagnostic bundle
            </Text>
            <Text size="xs" c="dimmed">
              Export recent logs and redacted connection metadata for support.
            </Text>
          </Stack>
          <Button
            variant="default"
            size="compact-xs"
            onClick={handleExportDiagnostic}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export bundle'}
          </Button>
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              Value suggestions
            </Text>
            <Text size="xs" c="dimmed">
              Forget values typed into the builder's condition rows.
            </Text>
          </Stack>
          <Button
            variant="default"
            size="compact-xs"
            onClick={handleClearValueHistory}
            disabled={clearingValues}
          >
            {clearingValues ? 'Clearing…' : 'Clear value history'}
          </Button>
        </Group>

        {columnKeyProtected !== null && (
          <Stack gap={2}>
            <Text size="sm" fw={600}>
              Local data protection
            </Text>
            {/* Never calls the data encrypted when the key sits beside it: that would oversell it. */}
            <Text size="xs" c="dimmed" data-testid="local-data-protection">
              {columnKeyProtected
                ? 'Saved queries, query history, value suggestions, the audit log and open tabs are encrypted on disk with a key held by the OS keychain.'
                : 'No OS keychain is available, so the key for saved queries, query history, value suggestions, the audit log and open tabs is stored unprotected next to them. Anyone who can read your user data folder can read them.'}
            </Text>
          </Stack>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" size="compact-xs" onClick={close}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
