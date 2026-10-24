import { z } from 'zod';
import type { SavedAggregationPayload, SavedFindPayload, SavedKind } from '@shared/types';

/**
 * Runtime shape of a saved query's `payload`, one schema per variant of
 * `SavedPayload`. The renderer reads `payload.kind` and the variant's own
 * fields as if they were there, so `saved:create` holds the payload to the
 * schema of the row's `kind`, and `saved:update` to the stored row's.
 *
 * Objects are loose on purpose: this checks the payload, it does not rewrite
 * it. `builder` keeps keys it does not name, such as the `conditions` / `logic`
 * the legacy filter shim compiles a pre-`queryRaw` filter from. `queryRaw` is
 * optional because W09 §1 types it so and rows saved before it existed lack it.
 */
export const StageSchema = z.looseObject({
  id: z.number().int(),
  op: z.string(),
  body: z.string(),
  enabled: z.boolean(),
  note: z.string().optional(),
});

export const SavedFindPayloadSchema = z.looseObject({
  kind: z.literal('find'),
  builder: z.looseObject({
    projection: z.array(z.string()),
    projectionRaw: z.string().optional(),
    sort: z.string(),
    limit: z.string(),
    // Text as the query bar holds it, not the wire enum/number, so a row
    // saved with an option the builder flags as a problem still loads.
    collation: z.string().optional(),
    hint: z.string().optional(),
    maxTimeMS: z.string().optional(),
    readPreference: z.string().optional(),
  }),
  queryRaw: z.string().optional(),
  description: z.string().optional(),
});

export const SavedAggregationPayloadSchema = z.looseObject({
  kind: z.literal('aggregation'),
  stages: z.array(StageSchema),
  description: z.string().optional(),
});

/**
 * The schema for a kind's payload. `script` has no `SavedPayload` variant and
 * nothing produces one, so it has no entry: callers leave a script payload
 * unchecked rather than invent a shape for it.
 */
export const SAVED_PAYLOAD_SCHEMAS: Partial<Record<SavedKind, z.ZodType>> = {
  find: SavedFindPayloadSchema,
  aggregation: SavedAggregationPayloadSchema,
};

// Compile-time only: a payload the renderer's own types allow must never be rejected at
// runtime, so a schema field stricter than its type fails to compile here. `Known` drops the
// index signatures `looseObject` adds, which an interface such as `Stage` cannot satisfy and
// which play no part in whether a payload is accepted.
type Known<T> = T extends readonly (infer U)[]
  ? Known<U>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: Known<T[K]> }
    : T;
type AssertAccepted<Schema extends z.ZodType, Payload extends Known<z.infer<Schema>>> = Payload;
export type SavedPayloadSchemasAcceptTheirTypes = [
  AssertAccepted<typeof SavedFindPayloadSchema, SavedFindPayload>,
  AssertAccepted<typeof SavedAggregationPayloadSchema, SavedAggregationPayload>,
];
