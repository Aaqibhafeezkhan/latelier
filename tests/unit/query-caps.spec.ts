import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_EJSON_BYTES } from '../../electron/mongo/ejson';
import { QUERY_TIMEOUT_MS } from '../../electron/mongo/timeouts';
import {
  LIMIT_EXPLANATION,
  QUERY_CAPS,
  limitChipText,
} from '../../src/pages/Workspace/queryCaps';

// The renderer words the caps the main process enforces. If either side moves,
// the sentence the user reads would lie, so the numbers are pinned together.
describe('queryCaps', () => {
  it('states the timeout the main process enforces', () => {
    expect(QUERY_CAPS.timeoutSeconds * 1000).toBe(QUERY_TIMEOUT_MS);
  });

  it('states the result size the main process enforces', () => {
    expect(QUERY_CAPS.maxResultMb * 1024 * 1024).toBe(DEFAULT_MAX_EJSON_BYTES);
  });

  it('puts both caps and the across-pages meaning in the explanation', () => {
    expect(LIMIT_EXPLANATION).toBe(
      'Total across all pages. Queries stop after 30 s; results over 50 MB are refused.',
    );
  });

  it('limitChipText is empty without a limit and "limit N" with one', () => {
    expect(limitChipText(null)).toBeNull();
    expect(limitChipText(10)).toBe('limit 10');
  });
});
