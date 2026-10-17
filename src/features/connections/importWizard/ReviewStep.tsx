import React from 'react';
import { Badge, Button, Checkbox, Group, PasswordInput, Stack, Table, Text, TextInput } from '@mantine/core';
import type { ImportCommitInput, ImportSource, Review, ReviewRow } from '@shared/types';
import { SubmitButton } from '../../../components/SubmitButton';
import { REPICK_LABEL, plural } from '../transferCopy';

type OkRow = Extract<ReviewRow, { ok: true }>;
interface Creds {
  username: string;
  password: string;
}

export interface ReviewStepProps {
  source: ImportSource;
  review: Review;
  busy: boolean;
  error?: string;
  passphraseError?: string;
  /** Present only when there is a step to go back to (Field Mapping). */
  onBack?(): void;
  onCancel(): void;
  onCommit(input: Omit<ImportCommitInput, 'token'>): void;
}

const DIRECT_HINT =
  'Connects to this one host only. Turn off if this is one member of a replica set and you want the other members discovered.';

/**
 * C14 §6: the one final approval every Import Source ends in. Lists every
 * candidate row before anything is written; only ticks, inline credentials,
 * Direct connection, the batch Read-only and the passphrase are editable.
 */
export function ReviewStep({ source, review, busy, error, passphraseError, onBack, onCancel, onCommit }: ReviewStepProps) {
  const hintId = React.useId();
  const okRows = review.rows.filter((r): r is OkRow => r.ok);
  const [ticked, setTicked] = React.useState<ReadonlySet<number>>(
    () => new Set(okRows.filter((r) => r.defaultTicked).map((r) => r.index)),
  );
  const [direct, setDirect] = React.useState<Record<number, boolean>>(() =>
    Object.fromEntries(okRows.flatMap((r) => (r.directConnection === null ? [] : [[r.index, r.directConnection]]))),
  );
  // Only rows the user typed in; an untouched row sends nothing and keeps what the source had.
  const [creds, setCreds] = React.useState<Record<number, Creds>>({});
  const [readOnly, setReadOnly] = React.useState(false);
  const [passphrase, setPassphrase] = React.useState('');
  const [withoutSecrets, setWithoutSecrets] = React.useState(false);

  const asksCredentials = (r: OkRow) =>
    ticked.has(r.index) && (r.needsCredentials || (r.passwordSealed && withoutSecrets));
  const credsFor = (r: OkRow): Creds => creds[r.index] ?? { username: r.authUsername ?? '', password: '' };
  const orphanPassword = (r: OkRow) => {
    const c = credsFor(r);
    return c.password !== '' && c.username.trim() === '';
  };
  const chosen = okRows.filter((r) => ticked.has(r.index));
  const asking = chosen.filter(asksCredentials);
  const needsPassphrase = review.hasEncryptedSecrets && !withoutSecrets;
  const canImport =
    chosen.length > 0 && asking.every((r) => !orphanPassword(r)) && !(needsPassphrase && passphrase === '');

  const toggle = (index: number, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });

  const commit = () =>
    onCommit({
      indices: chosen.map((r) => r.index),
      readOnly,
      directConnection: chosen.flatMap((r) => (r.directConnection === null ? [] : [{ index: r.index, value: direct[r.index]! }])),
      credentials: asking.flatMap((r) => {
        const c = creds[r.index];
        if (!c) return [];
        // The username always goes once the row was touched: blank means "no authentication".
        return [{ index: r.index, username: c.username.trim(), ...(c.password ? { password: c.password } : {}) }];
      }),
      ...(withoutSecrets ? { withoutSecrets: true } : needsPassphrase ? { passphrase } : {}),
    });

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        Nothing is written until you import. Renames, SSH and TLS files, and per-Connection Read-only are changed in
        the form afterwards.
      </Text>
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        <Table fz="xs" verticalSpacing={4} aria-label="Connections to import">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={28} />
              <Table.Th>Saved as</Table.Th>
              <Table.Th>Host</Table.Th>
              <Table.Th>User</Table.Th>
              <Table.Th>Settings</Table.Th>
              <Table.Th>Direct connection</Table.Th>
              <Table.Th>Notes</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {review.rows.map((r) =>
              r.ok ? (
                <React.Fragment key={r.index}>
                  <Table.Tr>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        aria-label={`Import ${r.savedAs}`}
                        checked={ticked.has(r.index)}
                        onChange={(e) => toggle(r.index, e.currentTarget.checked)}
                      />
                    </Table.Td>
                    <Table.Td fw={600}>
                      {r.savedAs}
                      {r.renamedFrom !== undefined && (
                        // Text, not colour alone: the saved name differs from the file's after a clash.
                        <Text size="xs" c="dimmed" fw={400}>
                          {`renamed from "${r.renamedFrom}"`}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td style={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>
                      {r.srv ? r.host : `${r.host}:${r.port}`}
                      {r.srv && (
                        <Badge size="xs" variant="light" ml={6}>
                          SRV
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.authUsername ?? '—'}
                      {r.hasPassword && (
                        <Badge size="xs" variant="light" ml={6}>
                          password
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {[`TLS ${r.tls ? 'on' : 'off'}`, `SSH ${r.ssh ? 'on' : 'off'}`, r.defaultDb ? `db ${r.defaultDb}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Table.Td>
                    <Table.Td>
                      {r.directConnection !== null && (
                        <Checkbox
                          size="xs"
                          aria-label={`Direct connection for ${r.savedAs}`}
                          aria-describedby={hintId}
                          checked={direct[r.index]!}
                          onChange={(e) => {
                            const on = e.currentTarget.checked;
                            setDirect((prev) => ({ ...prev, [r.index]: on }));
                          }}
                        />
                      )}
                    </Table.Td>
                    <Table.Td>{[...r.repick.map((f) => REPICK_LABEL[f]), ...r.warnings].join(' · ')}</Table.Td>
                  </Table.Tr>
                  {asksCredentials(r) && (
                    <Table.Tr>
                      <Table.Td />
                      <Table.Td colSpan={6}>
                        <Group gap="xs" wrap="nowrap" align="flex-start">
                          <TextInput
                            size="xs"
                            style={{ flex: 1 }}
                            aria-label={`Username for ${r.savedAs}`}
                            placeholder="Username"
                            autoComplete="off"
                            value={credsFor(r).username}
                            onChange={(e) => {
                              const username = e.currentTarget.value;
                              setCreds((prev) => ({ ...prev, [r.index]: { ...credsFor(r), username } }));
                            }}
                            error={orphanPassword(r) ? 'Add a username for this password.' : undefined}
                          />
                          <PasswordInput
                            size="xs"
                            style={{ flex: 1 }}
                            aria-label={`Password for ${r.savedAs}`}
                            placeholder="Password"
                            autoComplete="new-password"
                            value={credsFor(r).password}
                            onChange={(e) => {
                              const password = e.currentTarget.value;
                              setCreds((prev) => ({ ...prev, [r.index]: { ...credsFor(r), password } }));
                            }}
                          />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </React.Fragment>
              ) : (
                <Table.Tr key={r.index}>
                  <Table.Td>
                    <Checkbox size="xs" aria-label={`Import row ${r.index + 1}`} checked={false} disabled readOnly />
                  </Table.Td>
                  <Table.Td c="red">Row {r.index + 1}</Table.Td>
                  <Table.Td colSpan={5} c="red">
                    Not importable: {r.reason}
                  </Table.Td>
                </Table.Tr>
              ),
            )}
          </Table.Tbody>
        </Table>
      </div>
      {okRows.some((r) => r.directConnection !== null) && (
        <Text id={hintId} size="xs" c="dimmed">
          Direct connection: {DIRECT_HINT}
        </Text>
      )}
      {source !== 'latelier' && (
        <Checkbox
          size="xs"
          label="Read-only, for all rows"
          description="No writes from the app."
          checked={readOnly}
          onChange={(e) => setReadOnly(e.currentTarget.checked)}
        />
      )}
      {review.hasEncryptedSecrets && (
        <Group gap="md" align="flex-end">
          <PasswordInput
            label="Export Passphrase"
            size="xs"
            autoComplete="off"
            style={{ flex: 1 }}
            disabled={withoutSecrets}
            value={passphrase}
            onChange={(e) => setPassphrase(e.currentTarget.value)}
            error={passphraseError}
          />
          <Checkbox
            size="xs"
            label="Import without passwords"
            checked={withoutSecrets}
            onChange={(e) => setWithoutSecrets(e.currentTarget.checked)}
          />
        </Group>
      )}
      {error && (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="subtle" size="compact-xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {onBack && (
          <Button variant="default" size="compact-xs" onClick={onBack} disabled={busy}>
            Back
          </Button>
        )}
        <SubmitButton size="compact-xs" submitting={busy} disabled={!canImport} onClick={commit}>
          {busy ? 'Importing…' : chosen.length === 0 ? 'Import' : `Import ${plural(chosen.length, 'Connection')}`}
        </SubmitButton>
      </Group>
    </Stack>
  );
}
