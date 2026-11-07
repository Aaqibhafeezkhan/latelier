import React from 'react';
import { Alert, Button, Checkbox, Group, List, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import type { ConnectionExportResult, ConnectionSummary, ExportSecretField } from '@shared/types';
import { api, getErrorMessage } from '../../api/atelier';
import { fixedModalStyles } from '../../components/fixedModal';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { useOpenFocus } from '../../hooks/useOpenFocus';
import { SubmitButton } from '../../components/SubmitButton';
import { MIN_EXPORT_PASSPHRASE_LENGTH, plural } from './transferCopy';

type Written = Extract<ConnectionExportResult, { written: number }>;

const FIELD_LABEL: Record<ExportSecretField, string> = {
  password: 'password',
  sshPassword: 'SSH password',
  sshPassphrase: 'SSH key passphrase',
};

/**
 * Connection Export: tick the Connections to write, optionally encrypt their
 * secrets under an Export Passphrase, then main shows the save dialog and
 * writes the file. Cancelling that save dialog leaves this one as it was.
 *
 * With `ids` the set is already chosen (the Connections table's checked rows,
 * C13 §8), so there is no second checklist, only the passwords option.
 */
export function ConnectionExportDialog({ onClose, ids }: {
  onClose: () => void;
  ids?: string[];
}) {
  const close = useDialogFocusReturn(onClose);
  const [connections, setConnections] = React.useState<ConnectionSummary[] | null>(null);
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set(ids));
  const [includeSecrets, setIncludeSecrets] = React.useState(false);
  const [passphrase, setPassphrase] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<Written | null>(null);

  React.useEffect(() => {
    if (ids) return;
    let live = true;
    api.conn
      .list()
      .then((rows) => {
        if (!live) return;
        setConnections(rows);
        setTicked(new Set(rows.map((r) => r.id)));
      })
      .catch((e) => live && setError(getErrorMessage(e, 'Could not load Connections')));
    return () => {
      live = false;
    };
  }, [ids]);

  // With the checked rows already chosen there is nothing to load, so the
  // first field is there at mount; otherwise it arrives with the list.
  const bodyRef = useOpenFocus(ids !== undefined || connections !== null);

  const tooShort = passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH;
  const mismatch = confirm !== passphrase;
  const valid = ticked.size > 0 && (!includeSecrets || (!tooShort && !mismatch));

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.conn.export({
        ids: ids ?? (connections ?? []).filter((c) => ticked.has(c.id)).map((c) => c.id),
        includeSecrets,
        ...(includeSecrets ? { passphrase } : {}),
      });
      if ('written' in res) setResult(res);
    } catch (e) {
      setError(getErrorMessage(e, 'Export failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={submitting ? () => {} : close}
      title="Export Connections"
      centered
      size="md"
      // One height for every state: the checklist scrolls inside it, and the
      // passphrase fields are always there (disabled until ticked), so ticking
      // "Include passwords" never resizes the dialog or moves Export.
      styles={fixedModalStyles(440)}
    >
      <Stack gap="sm" ref={bodyRef} style={{ flex: 1, minHeight: 0 }}>
        {result ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <Text size="sm" role="status">
              {plural(result.written, 'Connection')} written.
            </Text>
            {result.omittedSecrets.length > 0 && (
              <List size="xs" spacing={2} mt="sm" aria-label="Secrets not included">
                {result.omittedSecrets.map((o) => (
                  <List.Item key={`${o.name}/${o.field}`}>
                    {o.name}: {FIELD_LABEL[o.field]} not included, it couldn&apos;t be read.
                  </List.Item>
                ))}
              </List>
            )}
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {ids ? (
                <Text size="sm">{plural(ids.length, 'checked Connection')}.</Text>
              ) : (
                <Checkbox.Group
                  label="Connections to export"
                  value={[...ticked]}
                  onChange={(ids) => setTicked(new Set(ids))}
                >
                  <Stack gap="var(--atelier-gap-xs)" mt={4}>
                    {(connections ?? []).map((c) => (
                      <Checkbox
                        key={c.id}
                        value={c.id}
                        label={c.name}
                        size="xs"
                      />
                    ))}
                  </Stack>
                </Checkbox.Group>
              )}
            </div>
            <Stack gap="sm" style={{ flex: 'none' }}>
              <Checkbox
                size="xs"
                label="Include passwords"
                description="Encrypted with an Export Passphrase. Without it the file carries no secrets."
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.currentTarget.checked)}
              />
              <Stack gap="xs">
                <PasswordInput
                  label="Export Passphrase"
                  size="xs"
                  autoComplete="new-password"
                  disabled={!includeSecrets}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.currentTarget.value)}
                  error={
                    includeSecrets && passphrase !== '' && tooShort
                      ? `At least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`
                      : undefined
                  }
                />
                <PasswordInput
                  label="Confirm Export Passphrase"
                  size="xs"
                  autoComplete="new-password"
                  disabled={!includeSecrets}
                  value={confirm}
                  onChange={(e) => setConfirm(e.currentTarget.value)}
                  error={includeSecrets && confirm !== '' && mismatch ? 'Does not match.' : undefined}
                />
              </Stack>
            </Stack>
          </>
        )}
        {error && (
          <Alert color="red" variant="light" role="alert" style={{ flex: 'none' }}>
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs" style={{ flex: 'none' }}>
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <SubmitButton
              size="compact-xs"
              miw={84}
              submitting={submitting}
              disabled={!valid}
              onClick={() => void submit()}
            >
              {submitting ? 'Exporting…' : 'Export'}
            </SubmitButton>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
