import React from 'react';
import { Button, Group, Modal, NativeSelect, Stack, Table, Text, TextInput } from '@mantine/core';
import type { AuditEntry, ConnectionSummary } from '@shared/types';
import { api, getErrorMessage } from '../api/atelier';
import { undoFailureMessage } from '../utils/auditUndo';
import { invalidateSampleSchemaCache } from '../features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../features/fieldSuggestions/sources/schemaEnumSource';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';

interface AuditLogModalProps {
  /** The Focused Tab's Connection; the picker falls back to the first one. */
  initialConnectionId: string | null;
  onClose: () => void;
}

function target(e: AuditEntry): string {
  if (e.summary.op === 'collectionRename') {
    return `${e.dbName}.${e.summary.fromName} → ${e.summary.toName}`;
  }
  return e.collection === null ? e.dbName : `${e.dbName}.${e.collection}`;
}

const CHANGED_LABELS = {
  validator: 'validator',
  validationLevel: 'validation level',
  validationAction: 'validation action',
  view: 'view definition',
} as const;

function details(e: AuditEntry): string {
  const s = e.summary;
  const parts: string[] = [];
  if ('changed' in s) parts.push(`changed ${s.changed.map((g) => CHANGED_LABELS[g]).join(', ')}`);
  if ('filter' in s) parts.push(s.filter);
  if ('fileName' in s) parts.push(s.format ? `${s.fileName} (${s.format.toUpperCase()})` : s.fileName);
  if ('insertedCount' in s && s.insertedCount !== undefined) parts.push(`${s.insertedCount} inserted`);
  if ('failedCount' in s && s.failedCount !== undefined) parts.push(`${s.failedCount} failed`);
  if ('matchedCount' in s && s.matchedCount !== undefined) parts.push(`${s.matchedCount} matched`);
  if ('modifiedCount' in s && s.modifiedCount !== undefined) parts.push(`${s.modifiedCount} modified`);
  if ('deletedCount' in s && s.deletedCount !== undefined) parts.push(`${s.deletedCount} deleted`);
  return parts.join(' · ');
}

function outcome(e: AuditEntry): string {
  if (e.undoneAt !== undefined) return 'Undone';
  if (e.outcome === 'ok') return 'Done';
  // An import that finished with rejected documents: partial, yet no error.
  if (e.outcome === 'partial' && e.errorCode === undefined) return 'Partial';
  return `${e.outcome === 'partial' ? 'Partial' : 'Failed'} (${e.errorCode ?? 'unknown'})`;
}

/**
 * One Connection's Audit Log, newest first, with Revert on the entries that
 * can still be undone. Filters match a database or collection name exactly.
 */
export function AuditLogModal({ initialConnectionId, onClose }: AuditLogModalProps) {
  const close = useDialogFocusReturn(onClose);
  const [connections, setConnections] = React.useState<ConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = React.useState(initialConnectionId);
  const [dbName, setDbName] = React.useState('');
  const [collection, setCollection] = React.useState('');
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reverting, setReverting] = React.useState<string | null>(null);
  const [revertError, setRevertError] = React.useState<string | null>(null);
  // Bumped after a Revert so the list re-reads `undoneAt` / `reversible`.
  const [reload, setReload] = React.useState(0);

  // Clear the previous Connection/database/collection's rows the instant the
  // query changes — otherwise they stay on screen (under the new label)
  // until the request below resolves, and stick around on a failed load
  // alongside the error. "Adjust state during render" pattern (see
  // TreeView's prevDocuments reset), not a useEffect, to avoid a cascading
  // render cycle.
  const listKey = `${connectionId ?? ''}|${dbName}|${collection}`;
  const [prevListKey, setPrevListKey] = React.useState(listKey);
  if (listKey !== prevListKey) {
    setPrevListKey(listKey);
    setEntries(null);
    setError(null);
  }

  React.useEffect(() => {
    api.conn
      .list()
      .then((rows) => {
        setConnections(rows);
        setConnectionId((id) => id ?? rows[0]?.id ?? null);
      })
      .catch((err: unknown) => setError(getErrorMessage(err, 'Failed to load connections.')));
  }, []);

  React.useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    api.audit
      .list({
        connectionId,
        dbName: dbName.trim() || undefined,
        collection: collection.trim() || undefined,
      })
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err, 'Failed to load the audit log.'));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, dbName, collection, reload]);

  const revert = (entry: AuditEntry) => {
    setReverting(entry.id);
    setRevertError(null);
    api.audit
      .undo({ entryId: entry.id })
      .catch((err: unknown) => setRevertError(undoFailureMessage(err)))
      .finally(() => {
        // Undo rewrites documents, and the entry can be a rename, drop or
        // import with no single collection, so the whole Connection's
        // field-suggestion samples go. The entry's own Connection, not the
        // picker's: it can have moved on while the request ran. Also when the
        // request failed, since it may have restored documents before that.
        invalidateSampleSchemaCache(entry.connectionId);
        invalidateSchemaEnumCache(entry.connectionId);
        setReverting(null);
        setReload((n) => n + 1);
      });
  };

  return (
    <Modal opened onClose={close} title="Audit log" centered size="xl">
      <Stack gap="md">
        <Group grow align="flex-end">
          <NativeSelect
            label="Connection"
            value={connectionId ?? ''}
            onChange={(e) => setConnectionId(e.currentTarget.value || null)}
            data={connections.map((c) => ({ value: c.id, label: c.name }))}
          />
          <TextInput label="Database" value={dbName} onChange={(e) => setDbName(e.currentTarget.value)} />
          <TextInput label="Collection" value={collection} onChange={(e) => setCollection(e.currentTarget.value)} />
        </Group>

        {error && (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
        {revertError && (
          <Text size="sm" c="red" role="alert">
            {revertError}
          </Text>
        )}
        {entries !== null && entries.length === 0 && !error && (
          <Text size="sm" c="dimmed">
            No Operations recorded.
          </Text>
        )}
        {entries !== null && entries.length > 0 && (
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Operation</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Details</Table.Th>
                <Table.Th>Outcome</Table.Th>
                <Table.Th aria-label="Undo" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{new Date(e.ranAt).toLocaleString()}</Table.Td>
                  <Table.Td>{e.op}</Table.Td>
                  <Table.Td>{target(e)}</Table.Td>
                  <Table.Td style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {details(e)}
                  </Table.Td>
                  <Table.Td>{outcome(e)}</Table.Td>
                  <Table.Td>
                    {e.reversible && (
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        loading={reverting === e.id}
                        disabled={reverting !== null}
                        onClick={() => revert(e)}
                      >
                        Revert
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
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
