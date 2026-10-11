import { Alert, List, Stack, Text } from '@mantine/core';
import type { ImportCommitResult } from '@shared/types';
import { REPICK_LABEL, plural } from '../transferCopy';

/** C14 §7: what the commit actually did, as main reports it. */
export function ResultStep({ result }: { result: ImportCommitResult }) {
  return (
    <Stack gap="xs">
      <Text size="sm" role="status">
        {plural(result.created.length, 'Connection')} imported.
      </Text>
      {result.skipped.length > 0 && (
        <Alert color="red" variant="light" title="Not imported">
          <List size="xs" spacing={2} aria-label="Connections not imported">
            {result.skipped.map((s) => (
              <List.Item key={s.index}>
                {s.name}: {s.reason}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {result.renamed.length > 0 && (
        <List size="xs" spacing={2} aria-label="Renamed Connections">
          {result.renamed.map((r) => (
            <List.Item key={r.index}>
              {r.from} → {r.to}
            </List.Item>
          ))}
        </List>
      )}
      {result.repick.length > 0 && (
        <List size="xs" spacing={2} aria-label="Files to pick again">
          {result.repick.map((r) => (
            <List.Item key={r.name}>
              {r.name}: {r.files.map((f) => REPICK_LABEL[f]).join(', ')}
            </List.Item>
          ))}
        </List>
      )}
      {result.secretsNotStored.length > 0 && (
        <List size="xs" spacing={2} aria-label="Secrets not stored">
          {result.secretsNotStored.map((s) => (
            <List.Item key={`${s.name}/${s.reason}`}>
              {s.name}: {s.reason}
            </List.Item>
          ))}
        </List>
      )}
      {result.warnings.length > 0 && (
        <List size="xs" spacing={2} aria-label="Warnings">
          {result.warnings.map((w) => (
            <List.Item key={`${w.name}/${w.message}`}>
              {w.name}: {w.message}
            </List.Item>
          ))}
        </List>
      )}
    </Stack>
  );
}
