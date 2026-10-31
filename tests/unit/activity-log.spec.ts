import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_LIMIT,
  ACTIVITY_MESSAGE_LIMIT,
  clearActivity,
  getActivity,
  recordActivity,
  subscribeActivity,
  type ActivityEntry,
} from '../../src/theme/activityLog';

const entry = (n: number, level: ActivityEntry['level'] = 'error'): ActivityEntry => ({
  id: `e${n}`,
  level,
  message: `message ${n}`,
  at: '2026-10-22T12:00:00.000Z',
});

beforeEach(() => clearActivity());

describe('activity log', () => {
  it('is empty when the module first loads, as after a restart', async () => {
    vi.resetModules();
    const fresh = await import('../../src/theme/activityLog');
    expect(fresh.getActivity()).toEqual([]);
  });

  it('starts empty and lists entries newest first', () => {
    expect(getActivity()).toEqual([]);
    recordActivity(entry(1));
    recordActivity(entry(2, 'warning'));
    expect(getActivity().map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(getActivity()[0]).toEqual(entry(2, 'warning'));
  });

  it('keeps exactly the limit, which is 100', () => {
    expect(ACTIVITY_LIMIT).toBe(100);
    for (let n = 1; n <= 100; n++) recordActivity(entry(n));
    expect(getActivity()).toHaveLength(100);
    expect(getActivity()[99]!.id).toBe('e1');
  });

  it('drops the oldest entry once past the limit', () => {
    for (let n = 1; n <= 101; n++) recordActivity(entry(n));
    const ids = getActivity().map((e) => e.id);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe('e101');
    expect(ids.at(-1)).toBe('e2');
    expect(ids).not.toContain('e1');
  });

  it('returns the same snapshot until something changes, and a new one after', () => {
    recordActivity(entry(1));
    const first = getActivity();
    expect(getActivity()).toBe(first);
    recordActivity(entry(2));
    expect(getActivity()).not.toBe(first);
    // The earlier snapshot is left as it was.
    expect(first.map((e) => e.id)).toEqual(['e1']);
  });

  it('clear empties the log', () => {
    recordActivity(entry(1));
    clearActivity();
    expect(getActivity()).toEqual([]);
  });

  it('notifies subscribers on record and on clear, and not after they unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribeActivity(a);
    subscribeActivity(b);
    recordActivity(entry(1));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubscribeA();
    clearActivity();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps a message of exactly 500 characters whole', () => {
    expect(ACTIVITY_MESSAGE_LIMIT).toBe(500);
    const message = 'x'.repeat(500);
    recordActivity({ ...entry(1), message });
    expect(getActivity()[0]!.message).toBe(message);
  });

  it('cuts a longer message to 500 characters, ending in an ellipsis, and leaves the rest of the entry alone', () => {
    const message = 'a'.repeat(499) + 'bcdef';
    recordActivity({ ...entry(1), title: 'Big', message });
    const [stored] = getActivity();
    expect(stored!.message).toBe('a'.repeat(499) + '…');
    expect(stored!.message).toHaveLength(500);
    expect(stored).toEqual({ ...entry(1), title: 'Big', message: 'a'.repeat(499) + '…' });
  });
});
