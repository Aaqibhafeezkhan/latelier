import { z } from 'zod';
import type { SchemaValidator } from './router.ts';

// Re-usable validators shared across domain specs. Domain-specific schemas
// live in their own files (e.g., electron/mongo/schemas.ts).

export const Port = z.number().int().min(1).max(65_535);
export const NonEmpty = z.string().min(1);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * The (connectionId, dbName, collection) triple identifies a single Mongo
 * collection target. Every channel that operates on a collection (query,
 * doc write, aggregation, index, meta) shares this shape.
 */
export const CollectionTargetSchema = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  collection: NonEmpty,
});

export const IdInputSchema = z.object({ id: NonEmpty });

/**
 * A schema whose input is `any` would accept every wire type and make the
 * check meaningless, so it is typed as accepting nothing and fails to register.
 */
type Accepted<T> = 0 extends 1 & T ? never : T;

/**
 * Shape a Zod parse into the router's validator. The result also states what
 * the schema accepts, so `router.register` can check that every payload
 * preload sends for the channel is one the schema takes.
 */
export function zodValidator<S extends z.ZodType>(schema: S): SchemaValidator<z.output<S>, Accepted<z.input<S>>> {
  return Object.assign((payload: unknown) => schema.parse(payload), { accepts: () => undefined });
}
