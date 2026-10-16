import React from 'react';
import { Button, Group, Modal, Stack, Switch, Text } from '@mantine/core';
import { useHints } from '../hints/HintsContext';
import { api, getErrorMessage } from '../api/atelier';
import { invalidateRecentValuesCache } from '../features/fieldSuggestions/sources';
import { notify } from '../theme/notifications';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';

const RESTORE_TABS_KEY = 'ui.workspace.restoreTabs';

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

  const handleRestoreTabs = async (next: boolean) => {
    setRestoreTabs(next);
    try {
      await api.prefs.set(RESTORE_TABS_KEY, next);
    } catch (err) {
      setRestoreTabs(!next);
      notify.error(getErrorMessage(err, 'Failed to save the tab restore setting.'));
    }
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

        <Group justify="flex-end">
          <Button variant="subtle" size="compact-xs" onClick={close}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
