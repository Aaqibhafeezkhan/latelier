import { describe, it, expect } from 'vitest';
import { humanBytes } from '../../src/utils/humanBytes';

describe('humanBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [150 * 1024, '150 KB'],
    [100 * 1024, '100 KB'],
    [99.9 * 1024, '99.9 KB'],
    [1024 ** 2, '1.0 MB'],
    [1024 ** 3, '1.0 GB'],
    [1024 ** 4, '1.0 TB'],
    [1024 ** 5, '1.0 PB'],
  ])('formats %d as %s', (n, expected) => {
    expect(humanBytes(n)).toBe(expected);
  });

  it('stays in petabytes past the largest unit instead of inventing one', () => {
    expect(humanBytes(1024 ** 6)).toBe('1024 PB');
  });

  it.each([NaN, Infinity, -Infinity])('reads %s as 0 B', (n) => {
    expect(humanBytes(n)).toBe('0 B');
  });
});
