import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { CreateCollectionDrawer } from '../../src/pages/Workspace/CreateCollectionDrawer';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('CreateCollectionDrawer — fixed dbName (navigator mode)', () => {
  it('submits with the fixed dbName and typed collection name', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });
    const onCreated = vi.fn();

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={onCreated}
      />,
    );

    expect(screen.queryByLabelText('Database name')).toBeNull();
    await userEvent.type(screen.getByLabelText('Collection name'), 'orders');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      options: {},
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ dbName: 'shop', name: 'orders' }));
  });

  // #91 — `submit` had no `submitting` guard at all before; the button
  // stayed real-enabled while submitting (SubmitButton) is what makes this
  // guard load-bearing rather than cosmetic.
  it('ignores a second click while a create is in flight, making one api.collection.create call', async () => {
    let resolveCreate!: (v: { name: string }) => void;
    const create = vi.fn(() => new Promise<{ name: string }>((r) => (resolveCreate = r)));
    installAtelierMock({ collection: { create } });

    render(
      <CreateCollectionDrawer connectionId="c1" dbName="shop" onCancel={() => {}} onCreated={() => {}} />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'orders');
    const submit = screen.getByText('Create collection').closest('button')!;
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate({ name: 'orders' });
  });

  it('toggling capped reveals a size field and includes it in the payload', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'logs');
    expect(screen.queryByLabelText('Capped size (bytes)')).toBeNull();

    await userEvent.click(screen.getByLabelText('Capped'));
    await waitFor(() => expect(screen.getByLabelText('Capped size (bytes)')).toBeTruthy());

    await userEvent.type(screen.getByLabelText('Capped size (bytes)'), '100000');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      options: { capped: true, size: 100000 },
    });
  });

  it('clustered and capped/time series exclude each other, and clustered posts its options', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: 'x' };
        },
      },
    });
    render(
      <CreateCollectionDrawer connectionId="c1" dbName="shop" onCancel={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Collection name'), 'orders');

    await userEvent.click(screen.getByLabelText('Capped'));
    expect((screen.getByLabelText('Clustered') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Capped'));
    await userEvent.click(screen.getByLabelText('Time series'));
    expect((screen.getByLabelText('Clustered') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Time series'));

    await userEvent.click(screen.getByLabelText('Clustered'));
    expect((screen.getByLabelText('Capped') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Time series') as HTMLInputElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Clustered index name'), 'by_id');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ options: { clustered: true, clusteredIndexName: 'by_id' } });
  });

  it('omits a blank clustered index name from the submitted options', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: 'x' };
        },
      },
    });
    render(
      <CreateCollectionDrawer connectionId="c1" dbName="shop" onCancel={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Collection name'), 'orders');
    await userEvent.click(screen.getByLabelText('Clustered'));
    await userEvent.type(screen.getByLabelText('Clustered index name'), '   ');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0] as { options: object }).options).toEqual({ clustered: true });
  });

  it('focuses and flags the capped size field on a validation error', async () => {
    installAtelierMock({});
    render(
      <CreateCollectionDrawer connectionId="c1" dbName="shop" onCancel={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Collection name'), 'logs');
    await userEvent.click(screen.getByLabelText('Capped'));
    const size = screen.getByLabelText('Capped size (bytes)') as HTMLInputElement;
    expect(size.type).toBe('number');
    expect(size.getAttribute('inputmode')).toBe('numeric');
    await userEvent.type(size, '100.5');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(document.activeElement).toBe(size));
    expect(size.getAttribute('aria-invalid')).toBe('true');
    const describedBy = size.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/positive integer/);
    // announced once: the field error, not also the bottom alert
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText(/positive integer/)).toHaveLength(1);
  });

  it('rejects a non-integer capped size before calling the API', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'logs');
    await userEvent.click(screen.getByLabelText('Capped'));
    await waitFor(() => expect(screen.getByLabelText('Capped size (bytes)')).toBeTruthy());
    await userEvent.type(screen.getByLabelText('Capped size (bytes)'), '100.5');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => {
      expect(screen.getByText(/positive integer/)).toBeTruthy();
    });
    expect(calls.length).toBe(0);
  });

  it('rejects a JSON array as collation', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'logs');
    await userEvent.click(screen.getByLabelText('Collation'));
    const collationField = await screen.findByLabelText('Collation EJSON');
    fireEvent.change(collationField, { target: { value: '[]' } });
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/collation: invalid JSON object/);
    });
    expect(calls.length).toBe(0);
  });

  it('rejects a JSON null as validator', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'logs');
    await userEvent.click(screen.getByLabelText('Validator'));
    const validatorField = await screen.findByLabelText('Validator EJSON');
    await userEvent.clear(validatorField);
    await userEvent.type(validatorField, 'null');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/validator: invalid JSON object/);
    });
    expect(calls.length).toBe(0);
  });

  it('shows an inline error on API failure and keeps the drawer open', async () => {
    installAtelierMock({
      collection: {
        create: async () => {
          throw { code: 'CONFLICT', message: 'collection already exists' };
        },
      },
    });

    render(
      <CreateCollectionDrawer
        connectionId="c1"
        dbName="shop"
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );

    await userEvent.type(screen.getByLabelText('Collection name'), 'orders');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/already exists/);
    });
    expect(screen.getByLabelText('Collection name')).toBeTruthy();
  });
});

describe('CreateCollectionDrawer — no fixed dbName (DetailPanel mode)', () => {
  it('renders a database name field and submits the typed value', async () => {
    const calls: unknown[] = [];
    installAtelierMock({
      collection: {
        create: async (input) => {
          calls.push(input);
          return { name: (input as { collection: string }).collection };
        },
      },
    });
    const onCreated = vi.fn();

    render(
      <CreateCollectionDrawer connectionId="c1" onCancel={() => {}} onCreated={onCreated} />,
    );

    await userEvent.type(screen.getByLabelText('Database name'), 'newapp');
    await userEvent.type(screen.getByLabelText('Collection name'), 'first');
    await userEvent.click(screen.getByText('Create collection'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ dbName: 'newapp', collection: 'first' });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ dbName: 'newapp', name: 'first' }),
    );
  });

  it('disables submit until both database and collection names are filled', async () => {
    installAtelierMock();
    render(<CreateCollectionDrawer connectionId="c1" onCancel={() => {}} onCreated={() => {}} />);

    const submit = screen.getByText('Create collection').closest('button')!;
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Database name'), 'newapp');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Collection name'), 'first');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * X15 T4 — the unsaved-changes guard.
 *
 * Already Mantine, and therefore already carrying Mantine's
 * `closeOnClickOutside: true` default: a backdrop click discarded a
 * half-configured collection form.
 *
 * Two of these tests are the ticket's mutation targets and are named as such.
 */

const drawer = () => screen.getByRole('dialog', { name: 'New collection — shop' });
const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });
/** The overlay carries no role by design, so it has no accessible handle. */
const overlay = () => document.body.querySelector('.mantine-Drawer-overlay') as HTMLElement;

/** Let a click's async handler settle so a *negative* assertion means something. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

function renderCreate(onCancel: () => void = vi.fn()) {
  installAtelierMock({});
  render(
    <CreateCollectionDrawer
      connectionId="c1"
      dbName="shop"
      onCancel={onCancel}
      onCreated={() => undefined}
    />,
  );
  return onCancel;
}

describe('CreateCollectionDrawer — unsaved-changes guard (X15 T4)', () => {
  /**
   * MUTATION TARGET 1 — delete `closeOnClickOutside={false}` from
   * CreateCollectionDrawer and the last assertion must go red: the backdrop
   * starts routing through `requestClose` and raises a prompt the user never
   * asked for. The other two assertions stay green under that mutation, which
   * is exactly why "no prompt" has to be asserted rather than "text survived".
   *
   * Do not "fix" this test into expecting a prompt. An inert backdrop is the
   * point: `closeOnClickOutside={false}` is what stops one stray click from
   * reaching the close path at all.
   */
  it('a backdrop click with a dirty field is inert — no close, no prompt, text intact', async () => {
    const onCancel = renderCreate();
    const field = screen.getByLabelText('Collection name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'orders' } });

    fireEvent.click(overlay());
    await settle();

    expect((screen.getByLabelText('Collection name') as HTMLInputElement).value).toBe('orders');
    expect(onCancel).not.toHaveBeenCalled();
    expect(discardPrompt()).toBeNull();
  });

  it('Escape with a dirty field prompts, and Cancel leaves the typed text intact', async () => {
    const onCancel = renderCreate();
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'orders' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Collection name') as HTMLInputElement).value).toBe('orders');
  });

  it('Escape with a dirty field closes once Discard is confirmed', async () => {
    const onCancel = renderCreate();
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'orders' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it('closing an untouched drawer from Cancel does not prompt', async () => {
    const onCancel = renderCreate();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(discardPrompt()).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * MUTATION TARGET 2 — narrow `isDirty` in CreateCollectionDrawer to a single
   * field (`name !== ''`, the obvious narrowing) and this must go red. The
   * collection name is deliberately left EMPTY here: the work at risk is in the
   * capped-size field, and a per-field check reports the form clean while
   * discarding it. Fifteen fields, one prompt — the disjunction is the contract.
   */
  it('dirtying a field other than the first still prompts', async () => {
    const onCancel = renderCreate();

    fireEvent.click(screen.getByLabelText('Capped'));
    const size = await screen.findByLabelText('Capped size (bytes)');
    fireEvent.change(size, { target: { value: '100000' } });
    expect((screen.getByLabelText('Collection name') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
  });
});
