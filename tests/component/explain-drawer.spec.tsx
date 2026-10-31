import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { IpcApi } from '@shared/ipc';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { ExplainDrawer } from '../../src/pages/Workspace/Aggregation/ExplainDrawer';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ExplainDrawer', () => {
  it('renders a COLLSCAN summary strip containing the literal string "COLLSCAN"', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('COLLSCAN');
    });
  });

  it('renders metric chips when executionStats is present', async () => {
    const runExplain = vi.fn(async () => ({
      plan: {
        queryPlanner: {
          winningPlan: {
            stage: 'FETCH',
            inputStage: { stage: 'IXSCAN', indexName: 'email_1', keyPattern: { email: 1 } },
          },
        },
        executionStats: {
          nReturned: 5,
          totalDocsExamined: 5,
          totalKeysExamined: 5,
          executionTimeMillis: 3,
        },
      },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('email_1');
      expect(dialog.textContent).toContain('5');
      expect(dialog.textContent).toContain('3');
    });
  });

  it('degrades gracefully: unrecognized plan shape hides the summary strip but still renders the full tree', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { weird: 1, nested: { deeper: 'value' } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('weird');
    });
    // No summary strip data-testid rendered for an unrecognized shape.
    expect(screen.queryByTestId('explain-summary-strip')).toBeNull();
  });

  it('preserves existing drawer contracts: Verbosity select and Close button', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    const onClose = vi.fn();
    render(<ExplainDrawer onClose={onClose} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(screen.getByLabelText('Verbosity')).toBeTruthy();
    // X15 T6 — the bespoke `aria-label="Close explain"` ✕ is gone; the close
    // control is now Mantine's, labelled "Close" like every other X15 dialog.
    const closeBtn = within(dialog).getByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves the role=alert error branch', async () => {
    const runExplain = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom');
  });

  it('Raw/Tree toggle switches the body to the raw <pre> dump and back', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('COLLSCAN');
    });

    // Tree mode (default): `winningPlan` is nested one level below the
    // visible top-level `queryPlanner` key, so it's collapsed and hidden —
    // a good discriminator for "we're not looking at the raw dump".
    //
    // X15 T6 — this used to be `dialog.querySelector('pre')`, which reaches
    // into the drawer's internal element tree. A `<pre>` has no implicit ARIA
    // role, so the accessible-query equivalent is the `explain-raw` testid the
    // migration put on it. Same discriminator, same three assertions.
    expect(within(dialog).queryByTestId('explain-raw')).toBeNull();
    expect(dialog.textContent).not.toContain('winningPlan');

    fireEvent.click(screen.getByLabelText('Switch to raw view'));

    const pre = within(dialog).getByTestId('explain-raw');
    expect(pre.textContent).toContain('winningPlan');

    fireEvent.click(screen.getByLabelText('Switch to tree view'));
    expect(within(dialog).queryByTestId('explain-raw')).toBeNull();
  });

  it('does not leave role="dialog" on the backdrop — it belongs to the panel', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    // MUTATION TARGET — the hand-rolled drawer put `role="dialog"` +
    // `aria-label="Explain plan"` on the `position: fixed` scrim and left the
    // panel unlabelled, so a screen reader announced the scrim. Move the role
    // back onto the overlay and this goes red twice over: `getByRole` becomes
    // ambiguous, and the overlay stops being role-less.
    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(within(dialog).getByLabelText('Verbosity')).toBeTruthy();

    const overlay = document.body.querySelector('.mantine-Drawer-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('role')).toBeNull();
  });

  it('moves focus into the panel on open — the hand-rolled drawer never did', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('Escape closes it, and focus returns to the trigger', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Explain</button>
          {open && <ExplainDrawer onClose={() => setOpen(false)} runExplain={runExplain} />}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Explain' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Explain plan' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('still exposes an Expand toggle in the tree', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Expand' }).length).toBeGreaterThan(0);
    });
  });
});

// W16 Tier 4 — "Create an index for this query". `AggregationTab` never
// passes `onCreateIndex` at all (see `query-bar-create-index.spec.tsx` for
// the wiring that supplies it), so these pin the drawer's own half:
// visible only for a find's COLLSCAN *and* a caller that opted in.
describe('ExplainDrawer — Create an index for this query (W16 Tier 4)', () => {
  const collscanPlan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };
  const ixscanPlan = {
    queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } } },
  };

  it('shows the button on a COLLSCAN when onCreateIndex is supplied', async () => {
    const runExplain = vi.fn(async () => ({ plan: collscanPlan }));
    render(
      <ExplainDrawer onClose={() => {}} runExplain={runExplain} onCreateIndex={() => {}} />,
    );
    await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(screen.getByTestId('explain-create-index')).toBeTruthy();
    });
  });

  it('hides the button on a COLLSCAN when onCreateIndex is omitted (AggregationTab)', async () => {
    const runExplain = vi.fn(async () => ({ plan: collscanPlan }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);
    await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(screen.getByTestId('explain-summary-strip')).toBeTruthy();
    });
    expect(screen.queryByTestId('explain-create-index')).toBeNull();
  });

  it('hides the button when the plan uses an index, even with onCreateIndex supplied', async () => {
    const runExplain = vi.fn(async () => ({ plan: ixscanPlan }));
    render(
      <ExplainDrawer onClose={() => {}} runExplain={runExplain} onCreateIndex={() => {}} />,
    );
    await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(screen.getByTestId('explain-summary-strip')).toBeTruthy();
    });
    expect(screen.queryByTestId('explain-create-index')).toBeNull();
  });

  it('clicking it closes the explain drawer and calls onCreateIndex', async () => {
    const runExplain = vi.fn(async () => ({ plan: collscanPlan }));
    const onClose = vi.fn();
    const onCreateIndex = vi.fn();
    render(
      <ExplainDrawer onClose={onClose} runExplain={runExplain} onCreateIndex={onCreateIndex} />,
    );
    await screen.findByRole('dialog', { name: 'Explain plan' });
    const button = await screen.findByTestId('explain-create-index');

    fireEvent.click(button);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreateIndex).toHaveBeenCalledTimes(1);
  });
});

// #507 — the stage tree between the summary strip and the raw plan.
describe('ExplainDrawer — stage tree', () => {
  const statsPlan = {
    queryPlanner: {
      winningPlan: {
        stage: 'FETCH',
        inputStage: { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } },
      },
    },
    executionStats: {
      executionStages: {
        stage: 'FETCH',
        nReturned: 7,
        docsExamined: 7,
        inputStage: {
          stage: 'IXSCAN',
          nReturned: 7,
          keysExamined: 7,
          executionTimeMillisEstimate: 4,
          indexName: 'a_1',
          keyPattern: { a: 1 },
        },
      },
    },
  };

  it('renders one row per stage with its own figures', async () => {
    const runExplain = vi.fn(async () => ({ plan: statsPlan }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const tree = await screen.findByRole('list', { name: 'Plan stages' });
    const items = within(tree).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-stage'))).toEqual(['FETCH', 'IXSCAN']);
    expect(items.map((i) => i.getAttribute('data-collscan'))).toEqual(['false', 'false']);
    const ixscan = items[1];
    expect(ixscan.textContent).toContain('IXSCAN');
    expect(ixscan.textContent).toContain('a_1');
    expect(ixscan.textContent).toContain('keysExamined: 7');
    expect(ixscan.textContent).toContain('~4ms');
    expect(items[0].textContent).toContain('docsExamined: 7');
  });

  it('a COLLSCAN row says COLLSCAN', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const tree = await screen.findByRole('list', { name: 'Plan stages' });
    const row = within(tree).getByRole('listitem');
    expect(row.textContent).toContain('COLLSCAN');
    expect(row.getAttribute('data-collscan')).toBe('true');
  });

  it('names the shard on the root row of each shard\'s plan', async () => {
    const runExplain = vi.fn(async () => ({
      plan: {
        queryPlanner: {
          winningPlan: {
            stage: 'SHARD_MERGE',
            shards: [{ shardName: 'rs0', winningPlan: { queryPlan: { stage: 'COLLSCAN' } } }],
          },
        },
      },
    }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const tree = await screen.findByRole('list', { name: 'Plan stages' });
    const rows = within(tree).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-stage'))).toEqual(['SHARD_MERGE', 'COLLSCAN']);
    expect(rows[1].textContent).toContain('shard rs0');
  });

  it('an unrecognized plan renders no stage tree but still renders the JSON tree', async () => {
    const runExplain = vi.fn(async () => ({ plan: { weird: 1 } }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.textContent).toContain('weird'));
    expect(screen.queryByRole('list', { name: 'Plan stages' })).toBeNull();
  });
});

// #160 — the plan badge opens the drawer on the plan it already holds.
describe('ExplainDrawer — initialPlan', () => {
  const plan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };

  it('shows the supplied plan without fetching, then fetches once when the verbosity changes', async () => {
    const runExplain = vi.fn(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'fresh_1' } } },
    }));
    render(
      <ExplainDrawer
        onClose={() => {}}
        initialPlan={plan}
        initialVerbosity="queryPlanner"
        runExplain={runExplain}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(within(dialog).getByTestId('explain-summary-strip').textContent).toContain('COLLSCAN');
    expect(runExplain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Verbosity'), { target: { value: 'executionStats' } });
    await waitFor(() => expect(dialog.textContent).toContain('fresh_1'));
    expect(runExplain).toHaveBeenCalledTimes(1);
    expect(runExplain).toHaveBeenCalledWith('executionStats', expect.any(String));
  });

  it('does not fetch when the supplied plan goes away while the drawer is open', async () => {
    const runExplain = vi.fn(async () => ({ plan }));
    const view = render(
      <ExplainDrawer onClose={() => {}} initialPlan={plan} runExplain={runExplain} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(within(dialog).getByTestId('explain-summary-strip')).toBeTruthy();

    // A re-run replaces `lastRun` (no plan yet) behind the open drawer.
    view.rerender(
      <ExplainDrawer onClose={() => {}} initialPlan={undefined} runExplain={runExplain} />,
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(runExplain).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId('explain-summary-strip')).toBeTruthy();
  });

  it('names itself "(not current)" when told the plan is stale', async () => {
    render(
      <ExplainDrawer onClose={() => {}} initialPlan={plan} stale runExplain={vi.fn(async () => ({ plan }))} />,
    );
    expect(await screen.findByRole('dialog', { name: 'Explain plan (not current)' })).toBeTruthy();
  });

  it('does not fetch on mount under StrictMode either', async () => {
    const runExplain = vi.fn(async () => ({ plan }));
    render(
      <React.StrictMode>
        <ExplainDrawer onClose={() => {}} initialPlan={plan} runExplain={runExplain} />
      </React.StrictMode>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    expect(within(dialog).getByTestId('explain-summary-strip')).toBeTruthy();
    expect(runExplain).not.toHaveBeenCalled();
  });

  it('tells the user and the main log when the plan cannot be saved', async () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({
      app: {
        saveFile: async () => {
          throw { code: 'SYSTEM', message: 'read-only volume' };
        },
        log,
      },
    });
    const runExplain = vi.fn(async () => ({ plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } }));
    render(<ExplainDrawer onClose={() => {}} runExplain={runExplain} />);
    await screen.findByRole('dialog', { name: 'Explain plan' });

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));

    expect(await screen.findByText('Save failed')).toBeTruthy();
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      message: 'explain plan save failed: read-only volume',
      source: 'component',
    });
  });
});
