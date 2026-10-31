import React from 'react';
import { ActionIcon, Badge, Box, Button, Group, Text, Tooltip } from '@mantine/core';
import { I } from '../../../icons';
import { themeVars } from '../../../theme/themeVars';
import { SubmitButton } from '../../../components/SubmitButton';
import { api, getErrorMessage } from '../../../api/atelier';
import { confirmDestructive } from '../../../utils/confirm';
import type { SavedKind, SavedQuery, SavedQuerySummary } from '@shared/types';

const KIND_LABEL: Record<SavedKind, string> = {
  find: 'Find',
  aggregation: 'Aggregation',
  script: 'Script',
};

interface SavedTabProps {
  connectionId: string;
  dbName: string;
  collection: string;
  refreshKey?: number;
  onRunHere: (saved: SavedQuery) => void;
  /**
   * Opens a saved aggregation or script as its own top-level workspace tab.
   * Those kinds don't share a runtime surface with the Documents view, so
   * they can't run in place the way a find query does.
   */
  onOpenInTab: (saved: SavedQuerySummary) => void;
}

export function SavedTab({
  connectionId,
  dbName,
  collection,
  refreshKey,
  onRunHere,
  onOpenInTab,
}: SavedTabProps) {
  const T = themeVars;
  const [items, setItems] = React.useState<SavedQuerySummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await api.saved.list({ connectionId, dbName, collection });
      setItems(list);
    } catch (e) {
      setErr(getErrorMessage(e, 'Failed to load saved queries'));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dbName, collection]);

  React.useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load, refreshKey]);

  const handlePrimary = async (summary: SavedQuerySummary) => {
    if (summary.kind !== 'find') {
      onOpenInTab(summary);
      return;
    }
    try {
      const full = await api.saved.get({ id: summary.id });
      onRunHere(full);
    } catch (e) {
      setErr(getErrorMessage(e, 'Failed to load query'));
    }
  };

  // N4.7 — this used to be a hand-rolled `role="alertdialog"` overlay
  // with its own backdrop, its own Escape listener and its own focus
  // behaviour, one tab away from the drawer's Reset, which already used the
  // modal manager. `confirmDestructive` is that same manager; Escape, the
  // backdrop and focus trapping come with it rather than being re-implemented.
  const requestDelete = async (target: SavedQuerySummary) => {
    const proceed = await confirmDestructive({
      title: `Delete "${target.name}"?`,
      body: 'This removes the saved query. This action cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!proceed) return;
    setDeleting(true);
    try {
      await api.saved.delete({ id: target.id });
      setItems((prev) => prev.filter((i) => i.id !== target.id));
    } catch (e) {
      setErr(getErrorMessage(e, 'Failed to delete'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* W15 §13.5 — the header survives loading, error and empty.
          This view used to early-return a bare centered message, so anyone
          switching here while it loaded got an unlabelled blank panel. */}
      <Group
        gap={6}
        wrap="nowrap"
        px={10}
        pt={10}
        pb={6}
        fz={10}
        fw={700}
        c={T.textMuted}
        style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}
      >
        <span style={{ flex: 1 }}>Saved · {collection}</span>
        <SubmitButton
          variant="default"
          size="compact-xs"
          h={18}
          px={6}
          fz={10}
          c={loading ? undefined : T.textMuted}
          onClick={() => void load()}
          submitting={loading}
          aria-label="Refresh saved queries"
        >
          Refresh
        </SubmitButton>
      </Group>

      {loading && (
        <Text fz={12} c={T.textMuted} px={10} pt={4} pb={10}>
          Loading…
        </Text>
      )}

      {!loading && err && (
        <Text fz={12} c={T.warn} px={10} pt={4} pb={10}>
          {err}
        </Text>
      )}

      {!loading && !err && items.length === 0 && (
        <Text fz={12} c={T.textMuted} px={10} pt={4} pb={10}>
          Nothing saved yet. Use Save in the toolbar above to keep one here.
        </Text>
      )}

      {!loading && !err && items.map((item) => (
        <Group
          key={item.id}
          gap={6}
          wrap="nowrap"
          px={10}
          py={7}
          fz={12}
          style={{ borderBottom: `1px solid ${T.border}` }}
        >
          {/* Kind label. `Badge` with this size/variant/color is the
              existing small-badge pattern in this file's siblings
              (ColumnChooser, PreviewPicker, QueryBar's advanced-count
              badge) — reused rather than hand-rolled, since SavedTab now
              lists every kind and needs to tell a find, an aggregation
              and a script apart at a glance. */}
          <Badge size="xs" variant="light" color="violet" style={{ flexShrink: 0 }}>
            {KIND_LABEL[item.kind]}
          </Badge>
          <Box style={{ flex: 1, overflow: 'hidden' }}>
            <Text fw={600} c={T.text} truncate="end" fz={12}>
              {item.name}
            </Text>
            <Text fz={10} c={T.textGhost} mt={1}>
              {new Date(item.updatedAt).toLocaleDateString()}
            </Text>
            {item.description && (
              <Text title={item.description} fz={10} c={T.textGhost} mt={1} truncate="end">
                {item.description}
              </Text>
            )}
          </Box>
          <Tooltip label={item.kind === 'find' ? 'Run here' : 'Open in a new tab'} withArrow openDelay={400}>
            <Button
              variant="light"
              size="compact-xs"
              h={20}
              px={7}
              fz={10}
              leftSection={item.kind === 'find' ? I.play : undefined}
              onClick={() => void handlePrimary(item)}
              aria-label={
                item.kind === 'find'
                  ? `Run "${item.name}" in this tab`
                  : `Open "${item.name}" in a new tab`
              }
            >
              {item.kind === 'find' ? 'Run' : '↗ Open'}
            </Button>
          </Tooltip>
          {/* W15 §13.5 — a tooltip is not an accessible name for an
              icon-only button; the aria-label says which query it deletes. */}
          <Tooltip label="Delete" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              size={22}
              c={deleting ? undefined : T.red}
              onClick={() => void requestDelete(item)}
              disabled={deleting}
              aria-label={`Delete "${item.name}"`}
            >
              {I.trash}
            </ActionIcon>
          </Tooltip>
        </Group>
      ))}
    </div>
  );
}
