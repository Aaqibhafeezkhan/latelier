import { describe, it, expect } from 'vitest';
import { BSONRegExp, Decimal128, Double, Int32, Long } from 'bson';
import {
  matchKey,
  pairInSourceOrder,
  valuesAtPath,
} from '../../electron/services/referencePairing';

describe('valuesAtPath', () => {
  it('reads a plain and a dotted field', () => {
    expect(valuesAtPath({ a: 1 }, 'a')).toEqual([1]);
    expect(valuesAtPath({ n: { k: 'x' } }, 'n.k')).toEqual(['x']);
  });

  it('reads a missing field as one undefined, as the server keys it null', () => {
    expect(valuesAtPath({ a: 1 }, 'b')).toEqual([undefined]);
    expect(valuesAtPath({ n: 5 }, 'n.k')).toEqual([]);
  });

  it('fans out through arrays of subdocuments at any depth', () => {
    const doc = { n: [{ k: 1 }, [{ k: 2 }], { z: 3 }] };
    expect(valuesAtPath(doc, 'n.k')).toEqual([1, 2, undefined]);
  });

  it('lets a leaf array stand for itself and each element', () => {
    expect(valuesAtPath({ tags: ['a', 'b'] }, 'tags')).toEqual([['a', 'b'], 'a', 'b']);
  });

  it('stops at a null on the way down the path', () => {
    expect(valuesAtPath({ n: null }, 'n.k')).toEqual([]);
    expect(valuesAtPath({ n: [null, { k: 1 }] }, 'n.k')).toEqual([1]);
  });

  it('does not read a prototype member as a field', () => {
    expect(valuesAtPath({}, 'constructor')).toEqual([undefined]);
  });
});

describe('matchKey', () => {
  it('keeps regex options a JS RegExp cannot hold, as distinct keys', () => {
    expect(matchKey(new BSONRegExp('a', 'x'))).not.toBe(matchKey(new BSONRegExp('a', '')));
    expect(matchKey(new BSONRegExp('a', 's'))).toContain('"options":"s"');
  });
});

describe('pairInSourceOrder', () => {
  it('orders documents by the source values that selected them', () => {
    const out = pairInSourceOrder(['b', 'a'], ['A', 'B'], [['a'], ['b']]);
    expect(out).toEqual(['B', 'A']);
  });

  it('emits a document once however often its value repeats in the source', () => {
    expect(pairInSourceOrder(['a', 'a'], ['A'], [['a']])).toEqual(['A']);
  });

  it('emits every document sharing one value, in the server order', () => {
    expect(pairInSourceOrder(['a'], ['first', 'second'], [['a'], ['a']])).toEqual(['first', 'second']);
  });

  it('keeps documents sharing one value together, ahead of the next source value', () => {
    const out = pairInSourceOrder(['a', 'b'], ['A1', 'B', 'A2'], [['a'], ['b'], ['a']]);
    expect(out).toEqual(['A1', 'A2', 'B']);
  });

  it('pairs a document found by an array element with any of its keys', () => {
    expect(pairInSourceOrder(['y', 'x'], ['X', 'Y'], [['x', 'x2'], ['y']])).toEqual(['Y', 'X']);
  });

  it('keeps a document that pairs with nothing, after the paired ones in server order', () => {
    const out = pairInSourceOrder(['a'], ['stray1', 'A', 'stray2'], [['q'], ['a'], ['r']]);
    expect(out).toEqual(['A', 'stray1', 'stray2']);
  });

  it('pairs numbers across their stored type and keeps the rest of the numeric cases unpaired', () => {
    const docs = ['int', 'long', 'double', 'five', 'zero'];
    const keys = [[new Int32(1)], [Long.fromNumber(6)], [new Double(7)], [new Int32(5)], [new Double(0)]];
    const source = [new Double(7), Long.fromNumber(6), new Int32(1), Decimal128.fromString('5'), new Double(-0)];
    // Decimal128(5) and -0 key apart from the stored 5 and 0, so those two documents
    // pair with nothing; they still come back, after the paired ones.
    expect(pairInSourceOrder(source, docs, keys)).toEqual(['double', 'long', 'int', 'five', 'zero']);
  });
});
