import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { DocumentEditor } from '../../src/pages/Workspace/DocumentEditor';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import type { IpcApi } from '@shared/ipc';
import type { ScriptEditorProps } from '../../src/components/ScriptEditor';

/**
 * `ScriptEditor` mounts a real CodeMirror 6 view, which needs layout APIs
 * jsdom doesn't implement (see `stage-accordion.spec.tsx`) — behavioral
 * coverage for the real editor lives in e2e. Here we stub it with a plain
 * `<textarea>` that forwards the controlled-component props the JSON view
 * relies on, plus a fake completion popup: typing a trailing `$` opens it,
 * and Escape on the field closes it — mirroring `@codemirror/autocomplete`'s
 * own Escape binding, which never calls `stopPropagation`. Mantine's Modal
 * closes on Escape via a `capture: true` `window` listener that fires before
 * any of this field's own handlers ever run, so `stopPropagation` from here
 * would always be too late — the same reason `ScriptEditor` marks its
 * `contentDOM` with `data-mantine-stop-propagation` while a completion is
 * open (`FieldAutocompleteInput`'s identical marker), which is what this
 * fake reproduces on its own textarea.
 */
function FakeJsonEditor({ value, onChange, onBlur, testId, ariaLabel }: ScriptEditorProps) {
  const [popupOpen, setPopupOpen] = React.useState(false);
  return (
    <div>
      <textarea
        data-testid={testId}
        aria-label={ariaLabel}
        data-mantine-stop-propagation={popupOpen ? 'true' : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setPopupOpen(e.target.value.endsWith('$'));
        }}
        onBlur={() => onBlur?.()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && popupOpen) setPopupOpen(false);
        }}
      />
      {popupOpen && <div role="listbox" aria-label="Suggestions" />}
    </div>
  );
}

vi.mock('../../src/components/ScriptEditor', () => ({
  ScriptEditor: (props: ScriptEditorProps) => <FakeJsonEditor {...props} />,
}));

afterEach(() => {
  uninstallAtelierMock();
  invalidateSampleSchemaCache();
  vi.restoreAllMocks();
});

const OID = '507f1f77bcf86cd799439011';

/** A result row as `find` delivers it: canonical sentinels, never live BSON. */
const DOC = {
  _id: { $oid: OID },
  name: 'widget',
  qty: { $numberInt: '5' },
  big: { $numberLong: '9007199254740993' },
  price: { $numberDouble: '1.5' },
  cost: { $numberDecimal: '1.10' },
  active: true,
  at: { $date: { $numberLong: '0' } },
  ref: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
  gone: null,
  tags: ['a'],
  nested: { city: 'A' },
};

type UpdateInput = Parameters<IpcApi['doc']['updateOne']>[0];

function setup({
  doc = DOC as unknown,
  updateOne = vi.fn<IpcApi['doc']['updateOne']>(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  findOne,
  prefs,
  sample,
  focusPath,
}: {
  doc?: unknown;
  updateOne?: ReturnType<typeof vi.fn<IpcApi['doc']['updateOne']>>;
  findOne?: IpcApi['query']['findOne'];
  prefs?: Partial<IpcApi['prefs']>;
  sample?: unknown[];
  focusPath?: string;
} = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  installAtelierMock({
    doc: { updateOne },
    ...(findOne ? { query: { findOne } } : {}),
    ...(prefs ? { prefs } : {}),
    ...(sample ? { meta: { sampleSchema: async () => ({ docs: sample }) } as never } : {}),
  });
  render(
    <DocumentEditor
      mode="edit"
      connectionId="c1"
      dbName="shop"
      collection="orders"
      doc={doc}
      focusPath={focusPath}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onClose, onSaved, updateOne };
}

function setupInsert({
  insert = vi.fn<IpcApi['doc']['insert']>(async () => ({ insertedId: { $oid: OID } })),
  insertMany,
  initialDocJson,
}: {
  insert?: ReturnType<typeof vi.fn<IpcApi['doc']['insert']>>;
  insertMany?: IpcApi['doc']['insertMany'];
  initialDocJson?: string;
} = {}) {
  const onClose = vi.fn();
  const onInserted = vi.fn();
  const onPartialInsert = vi.fn();
  installAtelierMock({
    doc: { insert, ...(insertMany ? { insertMany } : {}) },
  });
  render(
    <DocumentEditor
      mode="insert"
      connectionId="c1"
      dbName="shop"
      collection="orders"
      initialDocJson={initialDocJson}
      onClose={onClose}
      onInserted={onInserted}
      onPartialInsert={onPartialInsert}
    />,
  );
  return { onClose, onInserted, onPartialInsert, insert };
}

const insertEditor = () => screen.getByRole('dialog', { name: 'Insert document' });

const editor = () => screen.getByRole('dialog', { name: 'Edit document' });
const field = (name: string) => within(editor()).getByRole('textbox', { name }) as HTMLInputElement;
const row = (name: string) => editor().querySelector(`[data-field="${name}"]`) as HTMLElement;
const save = () => within(editor()).getByRole('button', { name: 'Save' });
const lastCall = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.at(-1)![0] as UpdateInput;
const typeSelect = (name: string) => within(row(name)).getByRole('combobox', { name: `${name} type` }) as HTMLSelectElement;
const addFieldBox = (parent = 'root') => within(editor()).getByTestId(`add-field-${parent}`);
const viewSwitch = (label: 'Fields' | 'JSON') => within(editor()).getByRole('radio', { name: label }) as HTMLInputElement;
const jsonBox = () => within(editor()).getByRole('textbox', { name: 'Document JSON' }) as HTMLTextAreaElement;
const filterBox = () => within(editor()).getByRole('textbox', { name: 'Filter fields' }) as HTMLInputElement;

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('DocumentEditor — the surface', () => {
  it('is a dialog named "Edit document" with the namespace beneath the title', () => {
    setup();
    expect(within(editor()).getByText('shop.orders')).toBeTruthy();
  });

  it('opens at the size remembered in prefs', async () => {
    setup({ prefs: { get: (async (key: string) => (key === 'ui.workspace.documentEditorSize' ? { width: 900, height: 500 } : null)) as IpcApi['prefs']['get'] } });
    const surface = screen.getByTestId('document-editor-surface');
    await waitFor(() => expect(surface.style.width).toBe('900px'));
    expect(surface.style.height).toBe('500px');
  });

  it('remembers a size the user drags to, and ignores the one it rendered', async () => {
    // Keyed by the observed element, not a single shared callback: the
    // Fields/JSON `SegmentedControl` renders Mantine's `FloatingIndicator`,
    // which constructs its own `ResizeObserver` too, and a single shared
    // `fire` variable would silently end up pointed at that one instead of
    // the surface's.
    const instances: { el: Element | null; cb: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: { el: Element | null; cb: () => void };
        constructor(cb: () => void) {
          this.entry = { el: null, cb };
          instances.push(this.entry);
        }
        observe(el: Element) {
          this.entry.el = el;
        }
        disconnect() {}
      },
    );
    const set = vi.fn(async (_k: string, v: unknown) => v);
    setup({
      prefs: {
        get: (async () => ({ width: 900, height: 500 })) as IpcApi['prefs']['get'],
        set: set as unknown as IpcApi['prefs']['set'],
      },
    });
    const surface = screen.getByTestId('document-editor-surface');
    await waitFor(() => expect(surface.style.width).toBe('900px'));
    const fire = () => instances.find((i) => i.el === surface)?.cb();

    fire();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(set).not.toHaveBeenCalled();

    surface.style.width = '800px';
    surface.style.height = '420px';
    fire();
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.workspace.documentEditorSize', { width: 800, height: 420 }));
    vi.unstubAllGlobals();
  });
});

describe('DocumentEditor — Fields view', () => {
  it('gives each scalar its own input, and renders the rest read-only', () => {
    setup();
    expect(field('name').value).toBe('widget');
    expect(field('qty').value).toBe('5');
    expect(field('big').value).toBe('9007199254740993');
    expect(field('price').value).toBe('1.5');
    expect(field('cost').value).toBe('1.10');
    expect(field('at').value).toBe('1970-01-01T00:00:00Z');
    expect(field('ref').value).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect((within(editor()).getByRole('switch', { name: 'active' }) as HTMLInputElement).checked).toBe(true);
    // `_id` is always locked; `nested` is a container — it has no textbox of
    // its own, its children (tested separately) do.
    for (const readOnly of ['_id', 'nested']) {
      expect(within(editor()).queryByRole('textbox', { name: readOnly })).toBeNull();
    }
    expect(within(row('gone')).getByText('null')).toBeTruthy();
    // `tags` is a container row (arrays as expandable element rows), not a
    // textbox of its own; its element gets one (tested separately).
    expect(within(editor()).queryByRole('textbox', { name: 'tags' })).toBeNull();
    expect(field('tags.0').value).toBe('a');
    expect((row('qty').querySelector('select') as HTMLSelectElement).value).toBe('int32');
    expect((row('big').querySelector('select') as HTMLSelectElement).value).toBe('long');
  });

  it('shows the local time beneath a date', () => {
    setup();
    expect(within(row('at')).getByText(`Local: ${new Date(0).toLocaleString()}`)).toBeTruthy();
  });

  it('never offers an input for a field name no update path can address', () => {
    setup({ doc: { _id: 1, 'a.b': 'x', $k: 'y' } });
    expect(within(editor()).queryByRole('textbox', { name: 'a.b' })).toBeNull();
    expect(within(editor()).queryByRole('textbox', { name: '$k' })).toBeNull();
  });

  it('marks a row edited from the diff, and clears the mark when the value goes back', () => {
    setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    expect(row('name').dataset.edited).toBe('true');
    expect(row('qty').dataset.edited).toBeUndefined();
    fireEvent.change(field('name'), { target: { value: 'widget' } });
    expect(row('name').dataset.edited).toBeUndefined();
  });

  it('keeps a numeric type when the text looks like another one', () => {
    setup();
    fireEvent.change(field('price'), { target: { value: '2' } });
    expect(row('price').dataset.edited).toBe('true');
    expect(within(row('price')).getByText('Double')).toBeTruthy();
  });

  it('holds text that does not parse, blocks Save, and counts as unsaved', async () => {
    const { updateOne } = setup();
    fireEvent.change(field('qty'), { target: { value: '1.5' } });
    expect(within(row('qty')).getByText(/whole number/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    await settle();
    expect(updateOne).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
  });

  it.each([
    ['qty', '99999999999', /whole number/],
    ['big', '9223372036854775808', /64 bits/],
    ['price', 'abc', /Enter a number/],
    ['cost', 'abc', /not a valid Decimal128/],
    ['at', '2026-01-01T00:00:00', /zone/],
    ['ref', 'xyz', /24 hexadecimal/],
  ])('refuses %s = %s', (name, text, message) => {
    setup();
    fireEvent.change(field(name), { target: { value: text } });
    expect(within(row(name)).getByText(message)).toBeTruthy();
  });

  it('refuses a date that matches the pattern but is not a real instant', () => {
    setup();
    fireEvent.change(field('at'), { target: { value: '2026-13-01T00:00:00Z' } });
    expect(within(row('at')).getByText(/zone/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the W17 warning on a disagreeing row, and it never blocks Save', async () => {
    const sample = [1, 2, 3].map((i) => ({ _id: i, name: { $numberInt: String(i) } }));
    setup({ sample });
    expect(await within(row('name')).findByTestId('document-editor-type-warning')).toBeTruthy();
    expect(within(row('qty')).queryByTestId('document-editor-type-warning')).toBeNull();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('DocumentEditor — saving', () => {
  it('saves each scalar with its type preserved, guarded by what it loaded', async () => {
    const { updateOne, onSaved } = setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.change(field('qty'), { target: { value: '6' } });
    fireEvent.change(field('big'), { target: { value: '9007199254740995' } });
    fireEvent.change(field('price'), { target: { value: '2' } });
    fireEvent.change(field('cost'), { target: { value: '2.20' } });
    fireEvent.change(field('at'), { target: { value: '2026-09-24T20:31:00Z' } });
    fireEvent.change(field('ref'), { target: { value: 'bbbbbbbbbbbbbbbbbbbbbbbb' } });
    fireEvent.click(within(editor()).getByRole('switch', { name: 'active' }));
    fireEvent.click(save());

    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = lastCall(updateOne);
    expect(call).toMatchObject({ connectionId: 'c1', dbName: 'shop', collection: 'orders' });
    expect(JSON.parse(call.updateJson)).toEqual({
      $set: {
        name: 'gadget',
        qty: { $numberInt: '6' },
        big: { $numberLong: '9007199254740995' },
        price: { $numberDouble: '2.0' },
        cost: { $numberDecimal: '2.20' },
        active: false,
        at: { $date: { $numberLong: String(Date.parse('2026-09-24T20:31:00Z')) } },
        ref: { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      },
    });
    const filter = JSON.parse(call.filterJson) as Record<string, unknown>;
    expect(filter._id).toEqual({ $oid: OID });
    expect(filter.big).toEqual({ $eq: { $numberLong: '9007199254740993' } });
    expect(filter.name).toEqual({ $eq: 'widget' });
    expect(Object.keys(filter)).toHaveLength(9);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('passes the Reversible entry id of the update to onSaved', async () => {
    const updateOne = vi.fn<IpcApi['doc']['updateOne']>(async () => ({
      matchedCount: 1,
      modifiedCount: 1,
      auditId: 'a2',
    }));
    const { onSaved } = setup({ updateOne });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('a2'));
  });

  it('sends nothing for an unchanged document and just closes', async () => {
    const { updateOne, onClose } = setup();
    fireEvent.click(save());
    await settle();
    expect(updateOne).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves on ⌘↵ and on Ctrl+↵, never on ⌘S', async () => {
    const { updateOne } = setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.keyDown(field('name'), { key: 's', metaKey: true });
    await settle();
    expect(updateOne).not.toHaveBeenCalled();
    fireEvent.keyDown(field('name'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
  });

  it('makes one request for a double click while the first is in flight', async () => {
    let resolve!: (v: { matchedCount: number; modifiedCount: number }) => void;
    const updateOne = vi.fn(() => new Promise<{ matchedCount: number; modifiedCount: number }>((r) => (resolve = r)));
    setup({ updateOne });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    const button = save();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(updateOne).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ matchedCount: 1, modifiedCount: 1 }));
  });

  it('shows an IPC error inline and keeps the draft', async () => {
    const updateOne = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'MONGO_ERROR' });
    });
    const { onSaved } = setup({ updateOne });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    expect(await within(editor()).findByText(/boom/)).toBeTruthy();
    expect(field('name').value).toBe('gadget');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('DocumentEditor — conflicts', () => {
  const conflicted = () => vi.fn<IpcApi['doc']['updateOne']>(async () => ({ matchedCount: 0, modifiedCount: 0 }));

  it('keeps the editor open with the draft intact when nothing matched', async () => {
    const { onSaved } = setup({ updateOne: conflicted() });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    expect(await within(editor()).findByText(/changed since you opened it/)).toBeTruthy();
    expect(field('name').value).toBe('gadget');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('Overwrite resends the same update with only _id as the filter', async () => {
    const updateOne = conflicted();
    setup({ updateOne });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    fireEvent.click(await within(editor()).findByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(2));
    const [first, second] = updateOne.mock.calls.map((c) => c[0]);
    expect(second!.updateJson).toBe(first!.updateJson);
    expect(JSON.parse(second!.filterJson)).toEqual({ _id: { $oid: OID } });
  });

  it('Reload puts the edits on top of the fresh copy, and the next save guards the fresh values', async () => {
    const updateOne = conflicted();
    const findOne = vi.fn<IpcApi['query']['findOne']>(async () => ({
      document: { ...DOC, name: 'server-name', qty: { $numberInt: '7' } },
      durationMs: 0,
    }));
    setup({ updateOne, findOne });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    fireEvent.click(await within(editor()).findByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(field('qty').value).toBe('7'));
    expect(JSON.parse(findOne.mock.calls[0]![0].filter)).toEqual({ _id: { $oid: OID } });
    expect(field('name').value).toBe('gadget');
    expect(row('name').dataset.edited).toBe('true');
    expect(row('qty').dataset.edited).toBeUndefined();
    expect(within(editor()).queryByText(/changed since you opened it/)).toBeNull();

    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(2));
    expect(JSON.parse(lastCall(updateOne).filterJson)).toEqual({ _id: { $oid: OID }, name: { $eq: 'server-name' } });
  });

  it('says the document was deleted when Reload finds nothing, and offers only Cancel', async () => {
    setup({ updateOne: conflicted(), findOne: async () => ({ document: null, durationMs: 0 }) });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    fireEvent.click(await within(editor()).findByRole('button', { name: 'Reload' }));
    expect(await within(editor()).findByText(/was deleted/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(within(editor()).queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('⌘↵ after a deleted conflict does not resend, and leaves the deleted notice in place', async () => {
    const { updateOne } = setup({ updateOne: conflicted() });
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(save());
    fireEvent.click(await within(editor()).findByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(within(editor()).getByText(/was deleted/)).toBeTruthy());
    updateOne.mockClear();

    fireEvent.keyDown(field('name'), { key: 'Enter', metaKey: true });
    await settle();
    expect(updateOne).not.toHaveBeenCalled();
    expect(within(editor()).getByText(/was deleted/)).toBeTruthy();
  });
});

describe('DocumentEditor — dismissal', () => {
  it('Escape closes a clean editor without prompting', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });

  it('Escape on a dirty draft prompts, and Cancel there keeps the edit', async () => {
    const { onClose } = setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(field('name').value).toBe('gadget');
  });

  it('a backdrop click on a dirty draft is inert: no close, no prompt', async () => {
    const { onClose } = setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(document.body.querySelector('.mantine-Modal-overlay') as HTMLElement);
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    expect(field('name').value).toBe('gadget');
  });
});

describe('DocumentEditor — nested objects', () => {
  it('edits a nested field in place, marking the field and its container edited', () => {
    setup();
    expect(field('nested.city').value).toBe('A');
    fireEvent.change(field('nested.city'), { target: { value: 'B' } });
    expect(row('nested.city').dataset.edited).toBe('true');
    expect(row('nested').dataset.edited).toBe('true');
    expect(row('name').dataset.edited).toBeUndefined();
  });

  it('saves a nested change as its dotted path, guarded by the value it loaded', async () => {
    const { updateOne } = setup();
    fireEvent.change(field('nested.city'), { target: { value: 'B' } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = lastCall(updateOne);
    expect(JSON.parse(call.updateJson)).toEqual({ $set: { 'nested.city': 'B' } });
    expect((JSON.parse(call.filterJson) as Record<string, unknown>)['nested.city']).toEqual({ $eq: 'A' });
  });

  it('resends the whole container when an unsafe-named nested field changes', async () => {
    const { updateOne } = setup({
      doc: { ...DOC, nested: { 'a.b': { $numberInt: '1' }, city: 'A' } },
    });
    fireEvent.change(field('nested.a.b'), { target: { value: '2' } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({
      $set: { nested: { 'a.b': { $numberInt: '2' }, city: 'A' } },
    });
  });

  it('starts expanded; Collapse hides its rows without discarding their edits', () => {
    setup();
    fireEvent.change(field('nested.city'), { target: { value: 'B' } });
    fireEvent.click(within(row('nested')).getByRole('button', { name: 'Collapse nested' }));
    expect(row('nested.city')).toBeNull();
    fireEvent.click(within(row('nested')).getByRole('button', { name: 'Expand nested' }));
    expect(field('nested.city').value).toBe('B');
  });

  it('keeps a collapsed container open while a nested row still has a parse error', () => {
    setup({ doc: { ...DOC, nested: { city: 'A', qty: { $numberInt: '5' } } } });
    fireEvent.change(field('nested.qty'), { target: { value: '1.5' } });
    fireEvent.click(within(row('nested')).getByRole('button', { name: 'Collapse nested' }));
    expect(row('nested.qty')).not.toBeNull();
    expect(within(row('nested.qty')).getByText(/whole number/)).toBeTruthy();
  });
});

describe('DocumentEditor — arrays', () => {
  it('renders each element as its own row, labelled [i], with no value control on the array itself', () => {
    setup();
    expect(within(row('tags')).queryByRole('textbox', { name: 'tags' })).toBeNull();
    expect(field('tags.0').value).toBe('a');
    expect(within(row('tags.0')).getByText('[0]')).toBeTruthy();
  });

  it('starts expanded, like an Object row', () => {
    setup();
    expect(row('tags.0')).toBeTruthy();
    expect(within(row('tags')).getByRole('button', { name: 'Collapse tags' })).toBeTruthy();
  });

  it('edits an element and saves the whole array, never by index', async () => {
    const { updateOne } = setup();
    fireEvent.change(field('tags.0'), { target: { value: 'b' } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({ $set: { tags: ['b'] } });
  });

  it('marks the array edited, but not the element row itself', () => {
    setup();
    fireEvent.change(field('tags.0'), { target: { value: 'b' } });
    expect(row('tags').dataset.edited).toBe('true');
    expect(row('tags.0').dataset.edited).toBeUndefined();
  });

  it('Add item appends a new empty-string element', () => {
    setup();
    fireEvent.click(within(within(editor()).getByTestId('add-item-tags')).getByRole('button', { name: 'Add item' }));
    expect(field('tags.1').value).toBe('');
    expect(row('tags').dataset.edited).toBe('true');
  });

  it('removing an element splices it out and shifts later indices down', async () => {
    const { updateOne } = setup({ doc: { ...DOC, tags: ['a', 'b', 'c'] } });
    fireEvent.click(within(row('tags.0')).getByRole('button', { name: 'Remove tags.0' }));
    expect(field('tags.0').value).toBe('b');
    expect(field('tags.1').value).toBe('c');
    expect(row('tags.2')).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({ $set: { tags: ['b', 'c'] } });
  });

  it('on remove, a later element keeps its pending text as it shifts down, and a reused index starts fresh', () => {
    setup({ doc: { ...DOC, tags: [1, 2] } });
    // An invalid edit at index 1 lives only in `texts`, keyed by that index,
    // never reaching the draft.
    fireEvent.change(field('tags.1'), { target: { value: 'oops' } });
    fireEvent.click(within(row('tags.0')).getByRole('button', { name: 'Remove tags.0' }));
    expect(field('tags.0').value).toBe('oops');
    // Add item re-appends at index 1 — that slot must not inherit the text
    // that used to live at index 1.
    fireEvent.click(within(within(editor()).getByTestId('add-item-tags')).getByRole('button', { name: 'Add item' }));
    expect(field('tags.1').value).toBe('');
  });

  it("removing an element never discards another element's unparseable edit, so Save stays blocked", () => {
    setup({ doc: { ...DOC, tags: [{ $numberInt: '1' }, { $numberInt: '2' }, { $numberInt: '3' }] } });
    fireEvent.change(field('tags.2'), { target: { value: '12x' } });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row('tags.0')).getByRole('button', { name: 'Remove tags.0' }));
    expect(field('tags.1').value).toBe('12x');
    expect(within(row('tags.1')).getByText(/whole number/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it('removing an element keeps a later element collapsed as it shifts down', () => {
    setup({ doc: { ...DOC, cast: [{ a: 1 }, { b: 2 }] } });
    fireEvent.click(within(row('cast.1')).getByRole('button', { name: 'Collapse cast.1' }));
    fireEvent.click(within(row('cast.0')).getByRole('button', { name: 'Remove cast.0' }));
    expect(within(row('cast.0')).getByRole('button', { name: 'Expand cast.0' })).toBeTruthy();
    expect(row('cast.0.b')).toBeNull();
  });

  it('an array of objects recurses: an element is an expandable row of its own', () => {
    setup({ doc: { ...DOC, cast: [{ name: 'x' }] } });
    expect(field('cast.0.name').value).toBe('x');
    fireEvent.change(field('cast.0.name'), { target: { value: 'y' } });
    expect(row('cast').dataset.edited).toBe('true');
    expect(row('cast.0').dataset.edited).toBeUndefined();
    expect(row('cast.0.name').dataset.edited).toBeUndefined();
  });

  it("removing an element doesn't hand its half-typed Add field name to the element that shifts into its place", () => {
    setup({ doc: { ...DOC, cast: [{ a: 1 }, { b: 2 }] } });
    fireEvent.change(within(editor()).getByLabelText('New field name under cast.0'), { target: { value: 'zzz' } });
    fireEvent.click(within(row('cast.0')).getByRole('button', { name: 'Remove cast.0' }));
    expect(field('cast.0.b').value).toBe('2');
    expect((within(editor()).getByLabelText('New field name under cast.0') as HTMLInputElement).value).toBe('');
  });

  it("a container's children sit inside its list item, below its own controls rather than beside them", () => {
    setup({ doc: { ...DOC, cast: [{ name: 'x' }] } });
    const nested = within(editor()).getByRole('list', { name: 'Fields of cast' });
    expect(nested.parentElement!.closest('[role="listitem"]')).toBe(row('cast'));
    const controls = within(row('cast')).getByRole('button', { name: 'Remove cast' }).closest('div[style*="flex"]')!;
    expect(controls.contains(nested)).toBe(false);
  });

  it('a nested array edits and saves as the whole outer array', async () => {
    const { updateOne } = setup({ doc: { ...DOC, m: [[1, 2]] } });
    fireEvent.change(field('m.0.0'), { target: { value: '9' } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({
      $set: { m: [[{ $numberInt: '9' }, { $numberInt: '2' }]] },
    });
  });
});

describe('DocumentEditor — type selector', () => {
  it('is the only way a type changes, converting losslessly when it can', async () => {
    const { updateOne } = setup();
    fireEvent.change(typeSelect('qty'), { target: { value: 'double' } });
    expect(row('qty').dataset.edited).toBe('true');
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({ $set: { qty: { $numberDouble: '5.0' } } });
  });

  it('clears to the target zero value when the conversion is not lossless', () => {
    setup();
    fireEvent.change(typeSelect('name'), { target: { value: 'int32' } });
    expect(field('name').value).toBe('0');
  });

  it('converting to Null drops the value input; converting away opens at the zero value', () => {
    setup();
    fireEvent.change(typeSelect('name'), { target: { value: 'null' } });
    expect(within(editor()).queryByRole('textbox', { name: 'name' })).toBeNull();
    expect(within(row('name')).getByText('null')).toBeTruthy();
    fireEvent.change(typeSelect('name'), { target: { value: 'string' } });
    expect(field('name').value).toBe('');
  });

  it('discards a pending parse error for text the new type no longer applies to', () => {
    setup();
    fireEvent.change(field('qty'), { target: { value: '1.5' } });
    expect(within(row('qty')).getByText(/whole number/)).toBeTruthy();
    fireEvent.change(typeSelect('qty'), { target: { value: 'double' } });
    expect(within(row('qty')).queryByText(/whole number/)).toBeNull();
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it('gives a bare JS number its own disabled placeholder, so picking Double is a real change', async () => {
    const { updateOne } = setup({ doc: { ...DOC, raw: 7 } });
    expect(typeSelect('raw').value).toBe('number');
    fireEvent.change(typeSelect('raw'), { target: { value: 'double' } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({ $set: { raw: { $numberDouble: '7.0' } } });
  });
});

describe('DocumentEditor — add field', () => {
  it('adds a field as a draft-only String row', () => {
    setup();
    fireEvent.change(within(addFieldBox()).getByRole('textbox'), { target: { value: 'sku' } });
    fireEvent.click(within(addFieldBox()).getByRole('button', { name: 'Add field' }));
    expect(field('sku').value).toBe('');
    expect(row('sku').dataset.edited).toBe('true');
  });

  it('refuses a duplicate name inline, leaving the draft untouched', () => {
    setup();
    fireEvent.change(within(addFieldBox()).getByRole('textbox'), { target: { value: 'name' } });
    fireEvent.click(within(addFieldBox()).getByRole('button', { name: 'Add field' }));
    expect(within(addFieldBox()).getByText(/already exists/)).toBeTruthy();
    expect(row('name').dataset.edited).toBeUndefined();
  });

  it('refuses a name an update path could not address', () => {
    setup();
    fireEvent.change(within(addFieldBox()).getByRole('textbox'), { target: { value: 'a.b' } });
    fireEvent.click(within(addFieldBox()).getByRole('button', { name: 'Add field' }));
    expect(within(addFieldBox()).getByText(/cannot be saved/)).toBeTruthy();
    expect(row('a.b')).toBeNull();
  });

  it('sends the new field on save, guarded by its absence', async () => {
    const { updateOne } = setup();
    fireEvent.change(within(addFieldBox()).getByRole('textbox'), { target: { value: 'sku' } });
    fireEvent.click(within(addFieldBox()).getByRole('button', { name: 'Add field' }));
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = lastCall(updateOne);
    expect(JSON.parse(call.updateJson)).toEqual({ $set: { sku: '' } });
    expect((JSON.parse(call.filterJson) as Record<string, unknown>).sku).toEqual({ $exists: false });
  });

  it('Escape with the suggestion popup open closes only the popup', async () => {
    const { onClose } = setup({ sample: [{ _id: 1, sku: 'x' }] });
    const input = within(addFieldBox()).getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 's' } });
    expect(await screen.findByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });
});

describe('DocumentEditor — remove field', () => {
  it('removes a field from the draft without confirmation', () => {
    setup();
    fireEvent.click(within(row('name')).getByRole('button', { name: 'Remove name' }));
    expect(row('name')).toBeNull();
  });

  it('sends the removal as $unset, guarded by the value it loaded', async () => {
    const { updateOne } = setup();
    fireEvent.click(within(row('name')).getByRole('button', { name: 'Remove name' }));
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = lastCall(updateOne);
    expect(JSON.parse(call.updateJson)).toEqual({ $unset: { name: '' } });
    expect((JSON.parse(call.filterJson) as Record<string, unknown>).name).toEqual({ $eq: 'widget' });
  });

  it('never offers Remove on _id', () => {
    setup();
    expect(within(row('_id')).queryByRole('button', { name: 'Remove _id' })).toBeNull();
  });
});

describe('DocumentEditor — view switching', () => {
  it('defaults to Fields, with no JSON box mounted', () => {
    setup();
    expect(viewSwitch('Fields').checked).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Document JSON' })).toBeNull();
  });

  it('shows the whole draft as EJSON text in the JSON view', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    const parsed = JSON.parse(jsonBox().value) as Record<string, unknown>;
    expect(parsed.name).toBe('widget');
    expect(parsed._id).toEqual({ $oid: OID });
  });

  it('pretty-prints the JSON with a 2-space indent, not the whole document on one line', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    expect(jsonBox().value).toContain('\n  "name"');
  });

  it('blocks the switch to JSON while Fields holds a value that does not parse, and explains why', () => {
    setup();
    fireEvent.change(field('qty'), { target: { value: '1.5' } });
    fireEvent.click(viewSwitch('JSON'));
    expect(viewSwitch('Fields').checked).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Document JSON' })).toBeNull();
    expect(within(editor()).getByText(/invalid values/)).toBeTruthy();
  });

  it('carries a JSON-view edit into Fields on switch back', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    const next = JSON.parse(jsonBox().value) as Record<string, unknown>;
    next.name = 'gadget';
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(next) } });
    fireEvent.click(viewSwitch('Fields'));
    expect(field('name').value).toBe('gadget');
    expect(row('name').dataset.edited).toBe('true');
  });

  it('carries a Fields edit into the JSON view', () => {
    setup();
    fireEvent.change(field('name'), { target: { value: 'gadget' } });
    fireEvent.click(viewSwitch('JSON'));
    expect((JSON.parse(jsonBox().value) as Record<string, unknown>).name).toBe('gadget');
  });

  it('blocks the switch back to Fields on invalid JSON, keeping the text and showing an error', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    fireEvent.change(jsonBox(), { target: { value: '{ not json' } });
    fireEvent.click(viewSwitch('Fields'));
    expect(viewSwitch('JSON').checked).toBe(true);
    expect(jsonBox().value).toBe('{ not json');
    expect(within(editor()).getByRole('alert')).toBeTruthy();
  });

  it('blocks Save the same way invalid JSON blocks the switch', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    fireEvent.change(jsonBox(), { target: { value: '{ not json' } });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an _id change in JSON with a clear inline error, blocking switch and Save', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    const next = JSON.parse(jsonBox().value) as Record<string, unknown>;
    next._id = { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(next) } });
    expect(within(editor()).getByText(/cannot be changed/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(viewSwitch('Fields'));
    expect(viewSwitch('JSON').checked).toBe(true);
  });

  it('a non-document JSON value (an array) is refused, not silently accepted', () => {
    setup();
    fireEvent.click(viewSwitch('JSON'));
    fireEvent.change(jsonBox(), { target: { value: '[1,2]' } });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(viewSwitch('Fields'));
    expect(viewSwitch('JSON').checked).toBe(true);
  });

  it('saves from the JSON view as the same kind of diff request Fields would send', async () => {
    const { updateOne } = setup();
    fireEvent.click(viewSwitch('JSON'));
    const next = JSON.parse(jsonBox().value) as Record<string, unknown>;
    next.name = 'gadget';
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(next) } });
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = lastCall(updateOne);
    expect(JSON.parse(call.updateJson)).toEqual({ $set: { name: 'gadget' } });
    expect((JSON.parse(call.filterJson) as Record<string, unknown>).name).toEqual({ $eq: 'widget' });
  });

  it('repairs a Shell Syntax body on blur and saves it as canonical EJSON', async () => {
    const { updateOne } = setup();
    fireEvent.click(viewSwitch('JSON'));
    const next = JSON.parse(jsonBox().value) as Record<string, unknown>;
    next.name = 'gadget';
    const shell = JSON.stringify(next).replace('"name":', 'name:');
    fireEvent.change(jsonBox(), { target: { value: shell } });
    fireEvent.blur(jsonBox());
    expect(jsonBox().value).toContain('"name"');
    fireEvent.click(save());
    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(JSON.parse(lastCall(updateOne).updateJson)).toEqual({ $set: { name: 'gadget' } });
  });

  it('Reload refreshes the JSON view text too, not just Fields', async () => {
    const findOne = vi.fn<IpcApi['query']['findOne']>(async () => ({
      document: { ...DOC, name: 'server-name' },
      durationMs: 0,
    }));
    setup({
      updateOne: vi.fn<IpcApi['doc']['updateOne']>(async () => ({ matchedCount: 0, modifiedCount: 0 })),
      findOne,
    });
    fireEvent.click(viewSwitch('JSON'));
    const next = JSON.parse(jsonBox().value) as Record<string, unknown>;
    next.qty = 6;
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(next) } });
    fireEvent.click(save());
    fireEvent.click(await within(editor()).findByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((JSON.parse(jsonBox().value) as Record<string, unknown>).name).toBe('server-name'));
    expect((JSON.parse(jsonBox().value) as Record<string, unknown>).qty).toBe(6);
  });

  it('commits a JSON edit typed after a failed Save before Reload merges, instead of dropping it', async () => {
    const findOne = vi.fn<IpcApi['query']['findOne']>(async () => ({
      document: { ...DOC, name: 'server-name' },
      durationMs: 0,
    }));
    setup({
      updateOne: vi.fn<IpcApi['doc']['updateOne']>(async () => ({ matchedCount: 0, modifiedCount: 0 })),
      findOne,
    });
    fireEvent.click(viewSwitch('JSON'));
    const first = JSON.parse(jsonBox().value) as Record<string, unknown>;
    first.qty = 6;
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(first) } });
    fireEvent.click(save());
    await within(editor()).findByRole('button', { name: 'Reload' });

    // Typed after the conflict notice appeared, and never committed by a
    // blur or another Save — this is the text Reload must not drop.
    const second = JSON.parse(jsonBox().value) as Record<string, unknown>;
    second.price = 9;
    fireEvent.change(jsonBox(), { target: { value: JSON.stringify(second) } });

    fireEvent.click(within(editor()).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((JSON.parse(jsonBox().value) as Record<string, unknown>).name).toBe('server-name'));
    expect((JSON.parse(jsonBox().value) as Record<string, unknown>).qty).toBe(6);
    expect((JSON.parse(jsonBox().value) as Record<string, unknown>).price).toBe(9);
  });
});

describe('DocumentEditor — filter box', () => {
  function docWithFields(n: number) {
    const out: Record<string, unknown> = { _id: { $oid: OID } };
    for (let i = 0; i < n; i++) out[`f${i}`] = i;
    return out;
  }

  it('does not show at 15 top-level fields', () => {
    setup({ doc: docWithFields(14) }); // 14 + _id = 15
    expect(within(editor()).queryByRole('textbox', { name: 'Filter fields' })).toBeNull();
  });

  it('shows past 15 top-level fields', () => {
    setup({ doc: docWithFields(15) }); // 15 + _id = 16
    expect(filterBox()).toBeTruthy();
  });

  it('narrows rows by name, case-insensitively, without touching hidden rows\' edits', () => {
    setup({ doc: docWithFields(15) });
    fireEvent.change(field('f2'), { target: { value: '99' } });
    fireEvent.change(filterBox(), { target: { value: 'F1' } });
    expect(row('f2')).toBeNull();
    expect(row('f1')).toBeTruthy();
    expect(row('f10')).toBeTruthy(); // "f10" contains "F1" case-insensitively
    fireEvent.change(filterBox(), { target: { value: '' } });
    expect(field('f2').value).toBe('99');
  });
});

describe('DocumentEditor — Edit in JSON link', () => {
  it('switches an unrenderable row\'s "Edit in JSON" link to the JSON view', () => {
    // A regex sentinel revives to bson's `BSONRegExp`, which `kindOf` has no
    // case for — unlike `Timestamp`, which extends `Long` and is not "other".
    setup({ doc: { ...DOC, re: { $regularExpression: { pattern: '^a', options: '' } } } });
    fireEvent.click(within(row('re')).getByRole('button', { name: 'Edit in JSON' }));
    expect(viewSwitch('JSON').checked).toBe(true);
  });

  it('never offers the link on a typed row', () => {
    setup();
    expect(within(row('name')).queryByRole('button', { name: 'Edit in JSON' })).toBeNull();
  });
});

describe('DocumentEditor — Escape layering (JSON view)', () => {
  it('closes only the completion popup on the first Escape', async () => {
    const { onClose } = setup();
    fireEvent.click(viewSwitch('JSON'));
    fireEvent.change(jsonBox(), { target: { value: `${jsonBox().value}$` } });
    expect(await screen.findByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(jsonBox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });

  it('closes the editor on Escape once no popup is open', async () => {
    const { onClose } = setup();
    fireEvent.click(viewSwitch('JSON'));
    fireEvent.keyDown(jsonBox(), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

// W18 §6 — Insert and Duplicate on the Document Editor: insert-many routing,
// the duplicate seed, the partial-insert banner, plus the mode-specific bits
// only the editor has — Fields as the default view, and Fields being
// unavailable for an array draft.
const insertField = (name: string) => within(insertEditor()).getByRole('textbox', { name }) as HTMLInputElement;
const insertSaveButton = () => within(insertEditor()).getByRole('button', { name: /^Insert/ });
const insertViewSwitch = (label: 'Fields' | 'JSON') =>
  within(insertEditor()).getByRole('radio', { name: label }) as HTMLInputElement;
const insertJsonBox = () => within(insertEditor()).getByRole('textbox', { name: 'Document JSON' }) as HTMLTextAreaElement;

describe('DocumentEditor — insert mode — creating a document', () => {
  it('is a dialog named "Insert document", opening on Fields with an empty draft', () => {
    setupInsert();
    expect(insertEditor()).toBeTruthy();
    expect(insertViewSwitch('Fields').checked).toBe(true);
    expect(within(insertEditor()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('Duplicate seeds the draft from the source document minus _id', () => {
    setupInsert({ initialDocJson: '{\n  "sku": "widget"\n}' });
    expect(insertField('sku').value).toBe('widget');
    expect(within(insertEditor()).queryByText('_id')).toBeNull();
  });

  it('a Duplicate pre-fill on its own is not dirty: Escape closes without prompting', async () => {
    const { onClose } = setupInsert({ initialDocJson: '{\n  "sku": "widget"\n}' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });

  it('Save with no edits sends the whole (empty) draft to doc:insert, not a diff', async () => {
    const { insert, onInserted } = setupInsert();
    fireEvent.click(insertSaveButton());
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(insert).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      docJson: '{}',
    });
    await waitFor(() => expect(onInserted).toHaveBeenCalledTimes(1));
  });

  it('sends the whole draft edited through Fields, with types preserved', async () => {
    const { insert } = setupInsert();
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '{"sku": "widget", "qty": 5}' } });
    fireEvent.click(insertViewSwitch('Fields'));
    fireEvent.click(insertSaveButton());
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(insert).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      docJson: '{"sku":"widget","qty":{"$numberInt":"5"}}',
    });
  });

  it('the button label tracks further edits after a refused switch to Fields, not the text at the time of refusal', async () => {
    setupInsert();
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1}]' } });
    // Refused: Fields shows one document, so this stays on JSON.
    fireEvent.click(insertViewSwitch('Fields'));
    expect(await screen.findByText(/Fields view is not available/)).toBeTruthy();

    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1},{"b":2},{"c":3}]' } });
    expect(await screen.findByRole('button', { name: 'Insert 3 documents' })).toBeTruthy();
    // The refusal message is stale advice now that the text has changed.
    expect(screen.queryByText(/Fields view is not available/)).toBeNull();

    fireEvent.change(insertJsonBox(), { target: { value: '{"a":1}' } });
    expect(await screen.findByRole('button', { name: 'Insert' })).toBeTruthy();
  });

  it('a top-level array in the JSON view inserts many, with the count on the button', async () => {
    const insertMany = vi.fn<IpcApi['doc']['insertMany']>(async () => ({ insertedCount: 2, insertedIds: [] }));
    const { onInserted } = setupInsert({ insertMany });
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1},{"b":2}]' } });
    expect(await screen.findByRole('button', { name: 'Insert 2 documents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert 2 documents' }));
    await waitFor(() => expect(insertMany).toHaveBeenCalledTimes(1));
    expect(insertMany).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      docsJson: '[{"a":{"$numberInt":"1"}},{"b":{"$numberInt":"2"}}]',
    });
    await waitFor(() => expect(onInserted).toHaveBeenCalledTimes(1));
  });

  it('refuses an empty array, disabling Insert', async () => {
    setupInsert();
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[]' } });
    expect(await screen.findByText('Array must contain at least one document')).toBeTruthy();
    expect(insertSaveButton()).toHaveProperty('disabled', true);
  });

  it('refuses an array with a non-object item, disabling Insert', async () => {
    setupInsert();
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1},"oops"]' } });
    expect(await screen.findByText('Every array item must be a document')).toBeTruthy();
    expect(insertSaveButton()).toHaveProperty('disabled', true);
  });

  it('Fields view is unavailable for an array draft, and says why', async () => {
    setupInsert();
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1}]' } });
    fireEvent.click(insertViewSwitch('Fields'));
    expect(await screen.findByText(/Fields view is not available for an array/)).toBeTruthy();
    // Stayed on JSON: the Fields row list never mounted.
    expect(within(insertEditor()).queryByRole('list', { name: 'Fields' })).toBeNull();
  });

  it('on a partial insertMany failure, keeps the editor open, shows the banner, and fires onPartialInsert instead of onInserted/onClose', async () => {
    const insertMany = vi.fn<IpcApi['doc']['insertMany']>(async () => {
      const err = new Error('E11000 duplicate key error') as Error & { code?: string; details?: unknown };
      err.code = 'CONFLICT';
      err.details = { insertedCount: 1 };
      throw err;
    });
    const { onClose, onInserted, onPartialInsert } = setupInsert({ insertMany });
    fireEvent.click(insertViewSwitch('JSON'));
    fireEvent.change(insertJsonBox(), { target: { value: '[{"a":1},{"b":2},{"c":3}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert 3 documents' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('1 of 3');
    expect(onClose).not.toHaveBeenCalled();
    expect(onInserted).not.toHaveBeenCalled();
    expect(onPartialInsert).toHaveBeenCalledTimes(1);
    expect(insertEditor()).toBeTruthy();
  });
});

// W18 §8 — Quick Edit's "open the editor on that field": the editor scrolls
// the row into view and focuses its control once, at mount.
// Mantine's `FocusTrap` (`@mantine/hooks`' `useFocusTrap`) does the actual
// focusing, asynchronously (`setTimeout(0)`), off a `data-autofocus`
// attribute the editor's own effect sets synchronously at mount — see that
// effect's comment for why a direct `.focus()` there loses the race. These
// wait for that timer to settle before reading `document.activeElement`,
// the same way `dialog-focus-return.spec.tsx` waits past Mantine's own
// 10ms focus-return timer.
const settleFocusTrap = async () => {
  // `useFocusTrap` (`@mantine/hooks`) schedules its own initial-focus pass
  // with a bare `setTimeout(0)`, not a measured delay — 30ms is just a
  // margin past that, the same order of magnitude `dialog-focus-return.
  // spec.tsx` uses for a *different* Mantine timer (`useFocusReturn`'s 10ms
  // return-focus delay on the discard prompt) for the same reason: give a
  // deferred Mantine effect room to run before reading `document.activeElement`.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
};

describe('DocumentEditor — focusPath (W18 §8)', () => {
  it('scrolls the field row into view and focuses its input', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    setup({ focusPath: 'name' });
    await settleFocusTrap();

    expect(scrollSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(field('name'));
  });

  it('focuses the collapse toggle for an Object row', async () => {
    setup({ focusPath: 'nested' });
    await settleFocusTrap();
    expect(document.activeElement).toBe(within(row('nested')).getByRole('button', { name: /Collapse nested/ }));
  });

  it('focuses the "Edit in JSON" link for an unrenderable ("other") row', async () => {
    setup({ doc: { ...DOC, re: { $regularExpression: { pattern: '^a', options: '' } } }, focusPath: 're' });
    await settleFocusTrap();
    expect(document.activeElement).toBe(within(row('re')).getByRole('button', { name: 'Edit in JSON' }));
  });

  it('leaves the default focus target alone when no focusPath is given', async () => {
    setup();
    await settleFocusTrap();
    // Mantine's trap still focuses *something* on open — the point is only
    // that it isn't steered onto a specific row.
    expect(document.activeElement?.hasAttribute('data-autofocus')).toBe(false);
  });
});
