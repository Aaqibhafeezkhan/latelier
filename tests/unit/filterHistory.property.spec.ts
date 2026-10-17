import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { HISTORY_CAP, initHistory, pushHistory, undo, redo } from '../../src/pages/Workspace/filterHistory';

describe('filterHistory: undo and redo are inverses', () => {
  it('k undos then k redos give back the same present, for any k up to the past length', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 30 }),
        fc.nat(),
        (pushes, kSeed) => {
          const h = pushes.reduce((acc, v) => pushHistory(acc, v), initHistory(-1));
          const k = kSeed % (h.past.length + 1);
          let walked = h;
          for (let i = 0; i < k; i++) walked = undo(walked);
          for (let i = 0; i < k; i++) walked = redo(walked);
          expect(walked.present).toBe(h.present);
          expect(walked.past).toEqual(h.past);
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`past never holds more than ${HISTORY_CAP} entries, whatever is pushed, undone or redone`, () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('push' as const), value: fc.integer(), key: fc.option(fc.constantFrom('a', 'b')) }),
      fc.constant({ kind: 'undo' as const }),
      fc.constant({ kind: 'redo' as const }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: HISTORY_CAP * 2 + 20 }), (ops) => {
        let h = initHistory(0);
        for (const o of ops) {
          if (o.kind === 'push') h = pushHistory(h, o.value, o.key ?? undefined);
          else if (o.kind === 'undo') h = undo(h);
          else h = redo(h);
          expect(h.past.length).toBeLessThanOrEqual(HISTORY_CAP);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('an edit that changes nothing leaves past exactly as it was, at the cap or below', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer(), { minLength: 1, maxLength: HISTORY_CAP + 30, size: 'max' }), (values) => {
        const h = values.reduce((acc, v) => pushHistory(acc, v), initHistory(-1));
        expect(pushHistory(h, h.present).past).toEqual(h.past);
      }),
      { numRuns: 50 },
    );
  });
});
