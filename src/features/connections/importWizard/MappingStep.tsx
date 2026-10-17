import React from 'react';
import { Button, Group, NativeSelect, Stack, Table, Text } from '@mantine/core';
import type { MapTarget, MappingCollection } from '@shared/types';
import { MAP_TARGETS } from './mapTargets';

export interface MappingStepProps {
  collections: MappingCollection[];
  /** Paths main left out because two lists in the file share them. */
  ambiguousCollections?: number;
  /** Mapping is being applied in main: Back and Next hold still so a second click can't race it. */
  busy?: boolean;
  onBack(): void;
  onNext(at: string, mapping: Partial<Record<MapTarget, string>>): void;
}

/** Path -> target. A `Map`: a path is a file key, and `__proto__` or `constructor` on a plain object would hit Object.prototype. */
type Assignment = ReadonlyMap<string, MapTarget>;

/** What main sends as the sample of a field it hides whole; anything else masked is a stripped string. */
const HIDDEN_SAMPLE = '••••';

/** Each target goes to at most one path; the first suggestion wins a tie. */
function suggestions(c: MappingCollection): Assignment {
  const taken = new Set<MapTarget>();
  const out = new Map<string, MapTarget>();
  for (const f of c.fields) {
    if (f.suggested && !taken.has(f.suggested)) {
      taken.add(f.suggested);
      out.set(f.path, f.suggested);
    }
  }
  return out;
}

const paths = (n: number): string => (n === 1 ? '1 path names' : `${n.toLocaleString()} paths name`);

function pickerLabel(c: MappingCollection): string {
  const rows = `${c.rows.toLocaleString()} ${c.rows === 1 ? 'row' : 'rows'}`;
  return c.at === '' ? `This file (${rows})` : `${c.at} (${rows})`;
}

/** C14 §5: tell main which field of an unrecognised JSON file is which part of a Connection. */
export function MappingStep({ collections, ambiguousCollections, busy = false, onBack, onNext }: MappingStepProps) {
  const [at, setAt] = React.useState(collections[0]!.at);
  const collection = collections.find((c) => c.at === at) ?? collections[0]!;
  const [assign, setAssign] = React.useState<Assignment>(() => suggestions(collection));

  const pick = (path: string) => {
    const c = collections.find((x) => x.at === path);
    if (!c) throw new Error(`MappingStep: no collection at "${path}"`);
    setAt(c.at);
    setAssign(suggestions(c));
  };

  const choose = (path: string, target: MapTarget | '') =>
    setAssign((prev) => {
      const next = new Map([...prev].filter(([p, t]) => p !== path && t !== target));
      if (target) next.set(path, target);
      return next;
    });

  const mapped = new Set(assign.values());
  const canNext = mapped.has('connectionString') || mapped.has('host');

  const next = () => {
    const mapping: Partial<Record<MapTarget, string>> = {};
    for (const [path, target] of assign) mapping[target] = path;
    onNext(collection.at, mapping);
  };

  return (
    <Stack gap="sm">
      {collections.length > 1 && (
        <NativeSelect
          size="xs"
          label="Connections are listed in"
          value={collection.at}
          onChange={(e) => pick(e.currentTarget.value)}
          data={collections.map((c) => ({ value: c.at, label: pickerLabel(c) }))}
        />
      )}
      {ambiguousCollections !== undefined && (
        <Text size="xs" c="orange">
          Some lists are left out: {paths(ambiguousCollections)} more than one list in this file, so which is meant can&apos;t be told.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        Say which field holds each part of a Connection. Map either a Connection string or a Host.
      </Text>
      {collection.truncatedRows !== undefined && (
        <Text size="xs" c="orange">
          Only the first 500 rows are read ({collection.truncatedRows.toLocaleString()} left out).
        </Text>
      )}
      {collection.ambiguousFields !== undefined && (
        <Text size="xs" c="orange">
          Some fields are left out: {paths(collection.ambiguousFields)} more than one value in a row, such as a key with a
          dot in it beside a nested key, so which is meant can&apos;t be told.
        </Text>
      )}
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <Table fz="xs" verticalSpacing={4} aria-label="Fields in the file">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Field</Table.Th>
              <Table.Th>Sample</Table.Th>
              <Table.Th>Use as</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {collection.fields.map((f) => (
              <Table.Tr key={f.path}>
                <Table.Td style={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{f.path}</Table.Td>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>
                  {f.masked && (f.sample === HIDDEN_SAMPLE || f.sample === '') ? (
                    <>
                      <span aria-hidden="true">{HIDDEN_SAMPLE}</span>
                      <Text size="xs" c="dimmed">
                        Taken from the file — not shown
                      </Text>
                    </>
                  ) : (
                    f.sample
                  )}
                </Table.Td>
                <Table.Td>
                  <NativeSelect
                    size="xs"
                    aria-label={`Use ${f.path} as`}
                    value={assign.get(f.path) ?? ''}
                    onChange={(e) => choose(f.path, e.currentTarget.value as MapTarget | '')}
                    data={[{ value: '', label: '—' }, ...MAP_TARGETS.map((t) => ({ value: t.target, label: t.label }))]}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Group justify="flex-end" gap="xs">
        <Button variant="subtle" size="compact-xs" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button size="compact-xs" disabled={!canNext || busy} onClick={next}>
          Next
        </Button>
      </Group>
    </Stack>
  );
}
