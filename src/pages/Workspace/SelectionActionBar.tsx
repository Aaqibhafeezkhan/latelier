import React from 'react';
import { ActionIcon, Button, Group } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { copyToClipboard } from '../../utils/clipboard';
import { I } from '../../icons';
import { useCollectionWorkspace } from './context';
import { EMPTY_DOCUMENTS, useResultSelection } from './resultSelection';
import { bandOccupant, resultPaneKind } from './resultPaneState';
import {
  buildDeleteSelectedFilterJson,
  selectedDocs,
  serializeSelectedForClipboard,
} from './selection';

interface SelectionActionBarProps {
  /** Fires with the selected documents (ascending index order) when the
   *  user confirms intent to delete. The caller derives the `{_id:{$in:
   *  [...]}}` filter and drives the shared DeleteConfirm count+token flow —
   *  this component only decides *whether* Delete is actionable. */
  onDeleteSelected: (docs: unknown[]) => void;
  /** Set while the rows on screen outlive the connection they came from. */
  connectionLost?: { reason: string; reconnecting: boolean; onReconnect: () => void };
}

// #106 — the strip's height, fixed regardless of selection state. The first
// selection ever made used to mount this bar and shift the grid below it by
// this exact amount mid-double-click, so the second click of a dblclick with
// no prior selection landed on the row above and copied the wrong value.
// Reserving the space (instead of mounting/unmounting it) makes the shift
// impossible rather than special-casing the copy path. Measured against the
// real rendered bar in Electron — confirm again if padding/font-size here
// change.
const BAR_HEIGHT = 31;

/**
 * The fixed band above the rows: a lost connection, a running find, or the
 * bulk actions for a selection (T0.4), one at a time. The outer strip always
 * renders when the workspace isn't read-only (#106 — see `BAR_HEIGHT`), so none
 * of them can move or cover a row. `ResultViewer` composes this as the
 * `SelectionBar` slot; `ScriptTab`'s read-only snapshot composition never
 * renders it at all (AC7), and `meta.isReadOnly` is checked here too so a
 * future composition mistake can't surface destructive actions there.
 */
export function SelectionActionBar({ onDeleteSelected, connectionLost }: SelectionActionBarProps) {
  const T = themeVars;
  const { state, meta, actions } = useCollectionWorkspace();
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  const selection = useResultSelection(documents);
  const [copied, setCopied] = React.useState(false);

  if (meta.isReadOnly) return null;

  const occupant = bandOccupant({
    lost: connectionLost !== undefined,
    // A first load has no rows to run over: `Body` shows placeholders instead.
    running: meta.isLoading && state.lastRun !== undefined,
    selected: selection.indices.size > 0,
  });
  const docs = selectedDocs(documents, selection.indices);
  // Null when none of the selected docs carry an `_id` (e.g. an `{_id: 0}`
  // projection) — Delete MUST stay disabled in that case rather than ever
  // falling back to an unfiltered delete-everything call.
  const deleteFilterJson = buildDeleteSelectedFilterJson(docs);

  const handleCopy = () => {
    const text = serializeSelectedForClipboard(docs);
    // The button's own "Copied" label is the success feedback, so it waits
    // for the write to resolve. A failure toasts and leaves the label
    // alone.
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const handleDelete = () => {
    if (!deleteFilterJson) return;
    onDeleteSelected(docs);
  };

  return (
    <Group
      data-testid="selection-bar"
      gap={themeVars.gapSm}
      wrap="nowrap"
      style={{
        height: BAR_HEIGHT,
        boxSizing: 'border-box',
        padding: '4px 14px',
        borderBottom: `1px solid ${T.border}`,
        background:
          occupant === 'selection' ? T.accentSoft : occupant === 'lost' ? T.warnSoft : 'transparent',
        flexShrink: 0,
        fontSize: T.fsXs,
      }}
    >
      {occupant === 'lost' && connectionLost && (
        <>
          <span
            role="status"
            data-testid="band-connection-lost"
            title={connectionLost.reason}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: T.warnText,
            }}
          >
            <strong>Connection lost.</strong> {connectionLost.reason}
          </span>
          <Button
            size="compact-xs"
            variant="default"
            style={{ flexShrink: 0 }}
            onClick={connectionLost.onReconnect}
            disabled={connectionLost.reconnecting}
          >
            {connectionLost.reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        </>
      )}
      {occupant === 'running' && (
        <>
          <span role="status" style={{ color: T.textMuted }}>
            Running…
          </span>
          <span style={{ flex: 1 }} />
          <Button
            data-testid="band-cancel"
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => actions.cancel()}
          >
            Cancel
          </Button>
        </>
      )}
      {/* Only above rows: the empty, error and never-run panes have nothing to select. */}
      {occupant === 'none' && resultPaneKind(state) === 'rows' && (
        <span
          data-testid="band-hint"
          style={{
            color: T.textGhost,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {`Select rows with the checkbox or ⌘/Ctrl-click to copy${meta.isView ? '' : ' or delete'} them`}
        </span>
      )}
      {occupant === 'selection' && (
        <>
          <span data-testid="selection-bar-count" style={{ color: T.text, fontWeight: 600 }}>
            {selection.indices.size} selected
          </span>
          <span style={{ flex: 1 }} />
          <Button
            data-testid="selection-bar-copy"
            size="compact-xs"
            variant="subtle"
            leftSection={copied ? I.check : I.copy}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {!meta.isView && (
            <Button
              data-testid="selection-bar-delete"
              size="compact-xs"
              variant="subtle"
              color="red"
              leftSection={I.trash}
              onClick={handleDelete}
              disabled={!deleteFilterJson}
              title={deleteFilterJson ? undefined : 'Selected documents have no _id to delete by'}
            >
              Delete
            </Button>
          )}
          <ActionIcon
            data-testid="selection-bar-clear"
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Clear selection"
            onClick={() => selection.clear()}
          >
            {I.close}
          </ActionIcon>
        </>
      )}
    </Group>
  );
}
