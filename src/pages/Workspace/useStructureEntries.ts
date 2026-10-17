import React from 'react';
import { getStructureEntries } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import type { SuggestionContext } from '../../features/fieldSuggestions/types';
import type { SchemaSampleEntry } from '@shared/types';

const EMPTY: ReadonlyMap<string, SchemaSampleEntry> = new Map();

/**
 * The collection's sampled type histogram, keyed by field path; empty until
 * it loads, and while `enabled` is false. Every caller shares one cached,
 * in-flight sample (`getStructureEntries`), so a row per condition costs one
 * round trip, not one each.
 *
 * A loaded sample is kept with the collection it came from, so a change of
 * collection shows nothing until the new sample arrives rather than the old
 * one.
 */
export function useStructureEntries(
  ctx: SuggestionContext | null,
  enabled: boolean,
): ReadonlyMap<string, SchemaSampleEntry> {
  const [loaded, setLoaded] = React.useState<{ key: string; entries: SchemaSampleEntry[] } | null>(null);
  const connectionId = ctx?.connectionId;
  const dbName = ctx?.dbName;
  const collection = ctx?.collection;
  const key = `${connectionId}\0${dbName}\0${collection}`;
  React.useEffect(() => {
    if (!enabled || !connectionId || !dbName || !collection) return;
    let live = true;
    void getStructureEntries(connectionId, dbName, collection).then((entries) => {
      if (live) setLoaded({ key, entries });
    });
    return () => {
      live = false;
    };
  }, [enabled, connectionId, dbName, collection, key]);
  return React.useMemo(
    () => (enabled && loaded?.key === key ? new Map(loaded.entries.map((e) => [e.path, e])) : EMPTY),
    [enabled, loaded, key],
  );
}
