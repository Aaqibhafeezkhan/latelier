import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  chipsFromValue,
  valueFromChips,
  chipText,
  parseChipText,
  isoToLocalInput,
  localInputToIso,
  type Chip,
} from '../../src/pages/Workspace/condValue';
import type { ValType } from '@shared/types';

// Two numbers are left out. `-0`: `String(-0)` and `JSON.stringify(-0)` both
// write "0", so no text form can carry it, and `toEqual` tells it from `0`.
// An integer past 2^53: `chipsFromValue` refuses it on purpose, keeping the
// text input (pinned in condValue.spec.ts).
const chipArb: fc.Arbitrary<Chip> = fc.oneof(
  fc.string(),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Object.is(n, -0) && (!Number.isInteger(n) || Number.isSafeInteger(n))),
  fc.boolean(),
  fc.constant(null),
);

describe('condValue properties', () => {
  it('a list of chips survives being written to the value and read back', () => {
    fc.assert(
      fc.property(fc.array(chipArb), (chips) => {
        expect(chipsFromValue(valueFromChips(chips), 'array')).toEqual(chips);
      }),
    );
  });

  it('every chip a list shows reads back as itself once edited, in every row type', () => {
    const valTypes: ValType[] = ['string', 'number', 'long', 'decimal', 'boolean', 'date', 'objectid', 'array'];
    fc.assert(
      fc.property(fc.array(chipArb, { maxLength: 4 }), fc.constantFrom(...valTypes), (els, vt) => {
        const chips = chipsFromValue(valueFromChips(els), vt);
        if (chips === null) return;
        expect(chips.map((c) => parseChipText(chipText(c, vt), vt))).toEqual(chips);
      }),
    );
  });

  it('a chip survives being shown as text and typed back in', () => {
    fc.assert(
      fc.property(chipArb, (chip) => {
        expect(parseChipText(chipText(chip, 'array'), 'array')).toEqual(chip);
      }),
    );
  });

  it('whatever is typed, its chip shows as text that reads back as the same chip, in every row type', () => {
    const valTypes: ValType[] = ['string', 'number', 'long', 'decimal', 'boolean', 'date', 'objectid', 'array'];
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...valTypes), (typed, vt) => {
        const chip = parseChipText(typed, vt);
        expect(parseChipText(chipText(chip, vt), vt)).toEqual(chip);
      }),
    );
  });

  // Holds in any zone, so it needs no pinned TZ (Stryker's runner ignores an
  // assigned one). The local text always survives. The instant survives too,
  // except inside a daylight-saving fall-back hour, where the same local text
  // also named an earlier instant and reading it back picks that one
  // (pinned in condValue.spec.ts).
  it('a date to the minute survives the datetime-local input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('2100-12-31T23:59:00Z'), noInvalidDate: true }),
          // The second 01:30 of New York's 2026 fall-back, so a run in such a
          // zone exercises the repeated-time branch.
          fc.constant(new Date('2026-11-01T06:30:00.000Z')),
        ),
        (d) => {
          const minute = new Date(Math.floor(d.getTime() / 60_000) * 60_000);
          const text = isoToLocalInput(minute.toISOString());
          const back = localInputToIso(text);
          expect(isoToLocalInput(back)).toBe(text);
          // Only a repeated local time may read back differently, and then
          // as its earlier occurrence (an hour, or half one in a few zones).
          if (back !== minute.toISOString()) expect(Date.parse(back)).toBeLessThan(minute.getTime());
        },
      ),
    );
  });
});
