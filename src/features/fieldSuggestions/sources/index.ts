import type { FieldSource, ValueSource } from '../types';
import { lastRunSource } from './lastRunSource';
import { lastRunValuesSource } from './lastRunValuesSource';
import { fieldOperatorSource, operatorSource } from './operatorSource';
import { recentValuesSource } from './recentValuesSource';
import { sampleSchemaSource } from './sampleSchemaSource';
import { sampleValuesSource } from './sampleValuesSource';
import { schemaEnumSource } from './schemaEnumSource';

export {
  fieldOperatorSource,
  lastRunSource,
  lastRunValuesSource,
  operatorSource,
  recentValuesSource,
  sampleSchemaSource,
  sampleValuesSource,
  schemaEnumSource,
};
export {
  invalidateSampleSchemaCache,
  setSampleSchemaCacheTtl,
} from './sampleSchemaSource';
export {
  invalidateRecentValuesCache,
  setRecentValuesCacheTtl,
} from './recentValuesSource';
export { invalidateSchemaEnumCache, setSchemaEnumCacheTtl } from './schemaEnumSource';

/**
 * Default field-name composition. Used by the `useSuggestions` hook when a
 * caller doesn't specify sources, and as the building block for surfaces
 * that want `[...DEFAULT_FIELD_SOURCES, operatorSource]`.
 *
 * Order isn't significant for correctness (the hook merges by path), but
 * earlier sources resolve first, so keep sync ahead of async.
 */
export const DEFAULT_FIELD_SOURCES: readonly FieldSource[] = [
  lastRunSource,
  sampleSchemaSource,
];

/**
 * Default value-position composition: the current results first (sync,
 * instant), then values persisted from earlier runs (async, per-field), the
 * validator's `$jsonSchema` enum (async, per collection) and the values of a
 * low-cardinality field in the cached sample (async, shares the field
 * sample's fetch).
 */
export const DEFAULT_VALUE_SOURCES: readonly ValueSource[] = [
  lastRunValuesSource,
  recentValuesSource,
  schemaEnumSource,
  sampleValuesSource,
];
