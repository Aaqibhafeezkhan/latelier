import { isSecretFieldPath } from '../../../utils/secretFieldPath';
import type { ValueSource } from '../types';
import { distinctValuesAt } from './lastRunValuesSource';
import { getSampleDocs } from './sampleSchemaSource';

/** More distinct values than this and the field is not worth listing. */
const MAX_DISTINCT = 20;

/**
 * Values of a low-cardinality field, read from the sample `sampleSchemaSource`
 * already fetched (same cache, TTL and in-flight promise, so no extra round
 * trip). A field with more than `MAX_DISTINCT` distinct values in the sample
 * suggests nothing: a handful of its values would be noise, not a choice.
 * Neither does a secret-named field.
 */
export const sampleValuesSource: ValueSource = async (ctx) => {
  const field = ctx.target.field.trim();
  // A secret-named field (the list main redacts from logs and refuses to
  // record) never shows its sampled plaintext.
  if (!field || isSecretFieldPath(field)) return [];
  const docs = await getSampleDocs(ctx.connectionId, ctx.dbName, ctx.collection);
  const values = distinctValuesAt(docs, field);
  if (values.length > MAX_DISTINCT) return [];
  return values.map((s) => ({ ...s, source: 'sample' }));
};
