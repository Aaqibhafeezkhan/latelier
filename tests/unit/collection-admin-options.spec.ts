import { describe, it, expect } from 'vitest';
import {
  buildCreateCollectionOptions,
  validateCollectionName,
} from '../../electron/mongo/CollectionAdminService';
import { ValidationError } from '../../electron/errors';

describe('buildCreateCollectionOptions', () => {
  it('returns an empty object when no options are set', () => {
    expect(buildCreateCollectionOptions({})).toEqual({});
  });

  it('refuses a pipeline without viewOn as VALIDATION on pipeline', () => {
    expect(() => buildCreateCollectionOptions({ pipeline: '[]' })).toThrow(ValidationError);
    expect(() => buildCreateCollectionOptions({ pipeline: '[]' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', details: { field: 'pipeline' } }),
    );
  });

  it('builds a view from viewOn and its pipeline', () => {
    expect(buildCreateCollectionOptions({ viewOn: 'src', pipeline: '[{"$limit":1}]' })).toEqual({
      viewOn: 'src',
      pipeline: [{ $limit: 1 }],
    });
  });

  it('accepts the errorAndLog validation action', () => {
    expect(buildCreateCollectionOptions({ validationAction: 'errorAndLog' })).toEqual({
      validationAction: 'errorAndLog',
    });
  });

  it('throws VALIDATION when capped is set without a size', () => {
    expect(() => buildCreateCollectionOptions({ capped: true })).toThrow(ValidationError);
    try {
      buildCreateCollectionOptions({ capped: true });
    } catch (err) {
      expect((err as { code?: string }).code).toBe('VALIDATION');
    }
  });

  it('builds capped options with size and optional max', () => {
    expect(buildCreateCollectionOptions({ capped: true, size: 1024 })).toEqual({
      capped: true,
      size: 1024,
    });
    expect(buildCreateCollectionOptions({ capped: true, size: 1024, max: 10 })).toEqual({
      capped: true,
      size: 1024,
      max: 10,
    });
  });

  it('maps timeseries fields', () => {
    const opts = buildCreateCollectionOptions({
      timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'hours' },
      expireAfterSeconds: 3600,
    });
    expect(opts).toEqual({
      timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'hours' },
      expireAfterSeconds: 3600,
    });
  });

  it('maps timeseries without optional metaField/granularity', () => {
    const opts = buildCreateCollectionOptions({ timeseries: { timeField: 'ts' } });
    expect(opts).toEqual({ timeseries: { timeField: 'ts' } });
  });

  it('parses collation EJSON', () => {
    const opts = buildCreateCollectionOptions({ collation: '{"locale":"en","strength":2}' });
    expect(opts).toEqual({ collation: { locale: 'en', strength: 2 } });
  });

  it('throws VALIDATION on invalid collation EJSON', () => {
    expect(() => buildCreateCollectionOptions({ collation: '{not json' })).toThrow(ValidationError);
  });

  it('parses validator EJSON and passes validationLevel/validationAction through', () => {
    const opts = buildCreateCollectionOptions({
      validator: '{"$jsonSchema":{"bsonType":"object"}}',
      validationLevel: 'strict',
      validationAction: 'warn',
    });
    expect(opts).toEqual({
      validator: { $jsonSchema: { bsonType: 'object' } },
      validationLevel: 'strict',
      validationAction: 'warn',
    });
  });

  it('throws VALIDATION on invalid validator EJSON', () => {
    expect(() => buildCreateCollectionOptions({ validator: '{not json' })).toThrow(ValidationError);
  });
});

describe('validateCollectionName', () => {
  it('rejects an empty name', () => {
    expect(() => validateCollectionName('')).toThrow(ValidationError);
  });

  it('rejects a system.-prefixed name', () => {
    expect(() => validateCollectionName('system.profile')).toThrow(ValidationError);
  });

  it('rejects a name containing a null character', () => {
    expect(() => validateCollectionName('orders\0evil')).toThrow(ValidationError);
  });

  it('accepts an ordinary name', () => {
    expect(() => validateCollectionName('orders')).not.toThrow();
  });
});
