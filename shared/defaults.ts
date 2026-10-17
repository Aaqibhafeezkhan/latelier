// Default values for workspace tab state. Kept out of `types.ts` so that
// types.ts remains a pure type-declaration module. These are pure object
// literals — no Node APIs — and are safely importable from both main and
// renderer.

import type {
  AggregationTabState,
  CollectionTabState,
  SchemaTabState,
  ScriptTabState,
} from './types';

// Deep-freeze the shared default objects to prevent accidental in-place
// mutation. Callers spread these into new tab state; any direct write to
// the default would silently affect every future tab seeded from it.
// We deep-freeze (and not just top-level) because the nested `builder`
// object and its arrays would otherwise still be shared by reference
// after a shallow spread.
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_COLLECTION_TAB_STATE: CollectionTabState = deepFreeze({
  activeView: 'documents',
  view: 'Tree',
  builder: {
    projection: [],
    sort: '',
    limit: '',
  },
  queryRaw: '{}',
  page: 0,
  pageSize: 50,
  activeBuilderTab: 'Builder',
});

export const DEFAULT_AGGREGATION_TAB_STATE: AggregationTabState = deepFreeze({
  stages: [],
  activeStageId: null,
  outputHeight: 260,
  outputView: 'Tree',
});

/**
 * Largest sample `meta:sampleSchema` accepts. Not raisable on its own:
 * `MetaService.sampleSchema` puts the `recent` and `random` branches (n docs
 * each) into one `$facet` output document, which carries BSON's 16 MB cap,
 * and a breach fails open to an empty sample.
 */
export const SCHEMA_SAMPLE_MAX = 200;

export const DEFAULT_SCHEMA_TAB_STATE: SchemaTabState = deepFreeze({
  sampleSize: 100,
});

export const DEFAULT_SCRIPT_TAB_STATE: ScriptTabState = deepFreeze({
  title: 'Script',
  source: '',
  maxTimeMs: 60_000,
  resultPanelHeight: 240,
});
