import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  expectSeparatorClampedAtBounds,
  expectSeparatorResizesPanel,
} from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import type { ScriptTab as ScriptTabModel, ScriptTabState } from '@shared/types';
import { ScriptTab } from '../../src/pages/Workspace/ScriptTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

// Spied so each write path can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));

// Mocked at the exact module ScriptTab imports; the rest stays real because
// the editor reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
  vi.mocked(invalidateSchemaEnumCache).mockClear();
});

function tab(over: Partial<ScriptTabModel> = {}): ScriptTabModel {
  return {
    id: 't1',
    kind: 'script',
    connectionId: 'c1',
    dbName: '',
    collection: '',
    position: 0,
    isActive: true,
    openedAt: new Date().toISOString(),
    pinned: false,
    state: {
      title: 'My script',
      source: '1 + 2',
      maxTimeMs: 60_000,
      resultPanelHeight: 240,
      ...(over.state ?? {}),
    },
    ...over,
  };
}

describe('ScriptTab', () => {
  it('renders the title and "no output yet" placeholder before any run', () => {
    installAtelierMock();
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);
    expect(screen.getByDisplayValue('My script')).toBeTruthy();
    expect(screen.getByText(/No output yet/i)).toBeTruthy();
  });

  it('names the editor region for screen readers', () => {
    installAtelierMock();
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);
    const content = screen.getByTestId('script-editor').querySelector('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('Script editor');
  });

  it('sizes the editor text from the --atelier-editor-font-size variable, 13px when unset', () => {
    installAtelierMock();
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);
    const rules = Array.from(document.styleSheets).flatMap((sheet) =>
      Array.from(sheet.cssRules).map((r) => r.cssText),
    );
    expect(rules.some((r) => r.includes('font-size: var(--atelier-editor-font-size, 13px)'))).toBe(
      true,
    );
  });

  it('Run button calls api.script.run with the tab source and patches lastResult', async () => {
    const runSpy = vi.fn<IpcApi['script']['run']>(async () => ({
      valueJson: '"hello"',
      printBuffer: '',
      durationMs: 12,
    }));
    installAtelierMock({
      script: { run: runSpy, cancel: async () => undefined },
    });

    const onPatch = vi.fn();
    render(<ScriptTab tab={tab()} onPatch={onPatch} />);
    fireEvent.click(screen.getByText('▶ Run'));

    await waitFor(() => {
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'c1',
          source: '1 + 2',
          maxTimeMs: 60_000,
          cancelToken: expect.any(String),
        }),
      );
    });

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          lastResult: expect.objectContaining({ valueJson: '"hello"' }),
          lastError: undefined,
        }),
      );
    });
  });

  it('renders the result value and print buffer after a run', () => {
    installAtelierMock();
    render(
      <ScriptTab
        tab={tab({
          state: {
            title: 'My script',
            source: 'print("hi"); 7',
            maxTimeMs: 60_000,
            resultPanelHeight: 240,
            lastResult: {
              valueJson: '7',
              printBuffer: 'hi\n',
              durationMs: 3,
            },
          },
        })}
        onPatch={() => {}}
      />,
    );
    expect(screen.getByText(/3 ms/)).toBeTruthy();
    // The value renders inside the result <pre>. Match the exact text node.
    const valueNode = screen.getAllByText('7').find((el) => el.tagName === 'PRE');
    expect(valueNode).toBeTruthy();
    // print buffer summary text
    expect(screen.getByText(/print output \(3 chars\)/)).toBeTruthy();
  });

  it('renders the error code and message when lastError is set', () => {
    installAtelierMock();
    render(
      <ScriptTab
        tab={tab({
          state: {
            title: 'My script',
            source: 'while (true) {}',
            maxTimeMs: 200,
            resultPanelHeight: 240,
            lastError: {
              code: 'TIMEOUT',
              message: 'script exceeded 200ms',
            },
          },
        })}
        onPatch={() => {}}
      />,
    );
    expect(screen.getByText('TIMEOUT')).toBeTruthy();
    expect(screen.getByText(/script exceeded 200ms/)).toBeTruthy();
  });

  it('Cancel button posts script.cancel with the in-flight token', async () => {
    let resolveRun!: (v: Awaited<ReturnType<IpcApi['script']['run']>>) => void;
    const runSpy = vi.fn<IpcApi['script']['run']>(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    const cancelSpy = vi.fn<IpcApi['script']['cancel']>(async () => undefined);
    installAtelierMock({
      script: {
        run: runSpy,
        cancel: cancelSpy,
      },
    });

    render(<ScriptTab tab={tab()} onPatch={() => {}} />);
    fireEvent.click(screen.getByText('▶ Run'));

    // The button flips to Cancel while the run is in-flight.
    const cancelBtn = await screen.findByText('Cancel');
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith(
        expect.objectContaining({ token: expect.any(String) }),
      );
    });
    // Match tokens
    const runCall = runSpy.mock.calls[0]![0] as { cancelToken?: string };
    const cancelCall = cancelSpy.mock.calls[0]![0] as { token: string };
    expect(cancelCall.token).toBe(runCall.cancelToken);

    // Let the in-flight run finish to keep React's effect cleanup happy.
    resolveRun({ valueJson: null, printBuffer: '', durationMs: 0 });
  });

  it('forwards title and dbName edits through onPatch', () => {
    installAtelierMock();
    const onPatch = vi.fn();
    render(<ScriptTab tab={tab()} onPatch={onPatch} />);

    fireEvent.change(screen.getByDisplayValue('My script'), {
      target: { value: 'Renamed' },
    });
    expect(onPatch).toHaveBeenCalledWith({ title: 'Renamed' });

    fireEvent.change(screen.getByPlaceholderText('(use default)'), {
      target: { value: 'mydb' },
    });
    expect(onPatch).toHaveBeenCalledWith({ dbName: 'mydb' });
  });

  // X11 phase 6 — reuse demonstration. ScriptTab is the second consumer of
  // the ResultViewer compound: same Tree/Json/Table slots, different
  // (synthetic, read-only) provider. These tests verify the seam by
  // exercising each view through ScriptTab's array-result path.
  it('renders an array result through ResultViewer.Tree (default view)', () => {
    installAtelierMock();
    const arrayJson = JSON.stringify([
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' },
      { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'beta' },
    ]);
    const { container } = render(
      <ScriptTab
        tab={tab({
          state: {
            title: 'List',
            source: 'db.users.find().toArray()',
            maxTimeMs: 60_000,
            resultPanelHeight: 320,
            resultView: 'Tree',
            lastResult: { valueJson: arrayJson, printBuffer: '', durationMs: 7 },
          },
        })}
        onPatch={() => {}}
      />,
    );
    // Tree view shows the last 8 chars of each $oid as the doc id, plus
    // the collapsed-preview fields.
    expect(container.textContent).toContain('99439011');
    expect(container.textContent).toContain('99439012');
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    // Doc count chip
    expect(container.textContent).toContain('2 docs');
  });

  it('switching to Table view renders ResultViewer.Table with column headers', () => {
    installAtelierMock();
    const arrayJson = JSON.stringify([
      { _id: 1, name: 'alpha', count: 10 },
      { _id: 2, name: 'beta', count: 20 },
    ]);
    const onPatch = vi.fn();
    render(
      <ScriptTab
        tab={tab({
          state: {
            title: 'Table demo',
            source: 'db.items.find().toArray()',
            maxTimeMs: 60_000,
            resultPanelHeight: 320,
            resultView: 'Table',
            lastResult: { valueJson: arrayJson, printBuffer: '', durationMs: 4 },
          },
        })}
        onPatch={onPatch}
      />,
    );
    // Table headers wired by ResultViewer.Table → TableView
    expect(screen.getByTestId('table-header-name')).toBeTruthy();
    expect(screen.getByTestId('table-header-count')).toBeTruthy();
  });

  it('a single record result renders through ResultViewer.Json (one-doc fallback)', () => {
    installAtelierMock();
    const recordJson = JSON.stringify({ _id: 7, label: 'singleton' });
    const { container } = render(
      <ScriptTab
        tab={tab({
          state: {
            title: 'One doc',
            source: 'db.users.findOne()',
            maxTimeMs: 60_000,
            resultPanelHeight: 320,
            lastResult: { valueJson: recordJson, printBuffer: '', durationMs: 2 },
          },
        })}
        onPatch={() => {}}
      />,
    );
    // JsonView pretty-prints the doc inside a card
    expect(container.textContent).toContain('"label"');
    expect(container.textContent).toContain('singleton');
  });
});

/**
 * `onPatch` is how the real app feeds a committed height back in as the next
 * `resultPanelHeight` prop. A `vi.fn()` spy can't prove `aria-valuenow`
 * tracks that round trip, so this wrapper actually does it.
 */
function ControlledScriptTab({ initial }: { initial: ScriptTabModel }) {
  const [t, setT] = useState(initial);
  const onPatch = (patch: Partial<ScriptTabState>) =>
    setT((prev) => ({ ...prev, state: { ...prev.state, ...patch } }));
  return <ScriptTab tab={t} onPatch={onPatch} />;
}

// A script can write to any collection of its Connection, and the renderer
// can't tell which, so a finished run drops the whole Connection's
// field-suggestion samples. A run that throws may have written first.
describe('ScriptTab — field-suggestion sample', () => {
  const invalidate = vi.mocked(invalidateSampleSchemaCache);

  it('drops the Connection\'s samples once a run finishes, not before', async () => {
    let finish!: () => void;
    const run = vi.fn<IpcApi['script']['run']>(
      () => new Promise((resolve) => { finish = () => resolve({ valueJson: '1', printBuffer: '', durationMs: 1 }); }),
    );
    installAtelierMock({ script: { run, cancel: async () => undefined } });
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);

    fireEvent.click(screen.getByText('▶ Run'));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();

    finish();

    await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1'));
    await waitFor(() => expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1'));
  });

  it('drops them when the run fails too, since it may have written before throwing', async () => {
    const run = vi.fn<IpcApi['script']['run']>(async () => {
      throw { code: 'SCRIPT_ERROR', message: 'boom' };
    });
    installAtelierMock({ script: { run, cancel: async () => undefined } });
    const onPatch = vi.fn();
    render(<ScriptTab tab={tab()} onPatch={onPatch} />);

    fireEvent.click(screen.getByText('▶ Run'));

    await waitFor(() => expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ lastError: expect.anything() })));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1');
    expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('leaves them alone while no run has happened', () => {
    installAtelierMock();
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);

    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
  });
});

describe('ScriptTab result-panel resize keyboard support (#56)', () => {
  function renderWithResult() {
    installAtelierMock();
    return render(
      <ControlledScriptTab
        initial={tab({
          state: {
            title: 'My script',
            source: 'db.users.find()',
            maxTimeMs: 60_000,
            resultPanelHeight: 240,
            lastResult: { valueJson: '[{"a":1}]', printBuffer: '', durationMs: 1 },
          },
        })}
      />,
    );
  }

  it('is reachable in the tab order right after the result panel content', async () => {
    const user = userEvent.setup();
    renderWithResult();
    const handle = screen.getByRole('separator', { name: 'Resize result panel' });
    // Landing on the handle by tabbing *forward* would first have to pass
    // through the CodeMirror editor, whose own Tab keymap (indentWithTab)
    // intercepts the key for indentation — not a resize-separator concern.
    // Tabbing *backward* from the first focusable result-view control proves
    // the same sequential-order membership without that detour.
    await user.click(screen.getByRole('button', { name: 'Tree' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(handle);
  });

  it('ArrowUp/ArrowDown resize the result panel and keep aria-valuenow and the real height in sync', async () => {
    const user = userEvent.setup();
    renderWithResult();
    const handle = screen.getByRole('separator', { name: 'Resize result panel' });
    const panel = handle.nextElementSibling as HTMLElement;

    await user.click(screen.getByRole('button', { name: 'Tree' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(handle);

    await expectSeparatorResizesPanel(handle, panel, {
      growKey: '{ArrowUp}',
      shrinkKey: '{ArrowDown}',
      afterGrow: '250',
      afterShrink: '230',
    });
  });

  it('Home and End reach the bounds and stay clamped and focused past them', async () => {
    const user = userEvent.setup();
    renderWithResult();
    const handle = screen.getByRole('separator', { name: 'Resize result panel' });

    await user.click(screen.getByRole('button', { name: 'Tree' }));
    await user.tab({ shift: true });

    await expectSeparatorClampedAtBounds(handle, {
      min: '80',
      max: '800',
      shrinkKey: '{ArrowDown}',
      growKey: '{ArrowUp}',
    });
  });
});

describe('ScriptTab — completion database', () => {
  function installListSpy() {
    const listSpy = vi.fn<IpcApi['meta']['listCollections']>(async () => []);
    installAtelierMock({ meta: { listCollections: listSpy } });
    return listSpy;
  }

  it("lists the connection's default database's collections when the DB field is blank", async () => {
    const listSpy = installListSpy();
    render(<ScriptTab tab={tab()} defaultDb="smoke" onPatch={() => {}} />);
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'smoke' }),
    );
    expect(listSpy).not.toHaveBeenCalledWith(expect.objectContaining({ dbName: 'test' }));
  });

  it('a typed database name wins over the connection default', async () => {
    const listSpy = installListSpy();
    render(
      <ScriptTab
        tab={tab({ state: { title: 't', source: '', dbName: 'typed' } })}
        defaultDb="smoke"
        onPatch={() => {}}
      />,
    );
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'typed' }),
    );
    expect(listSpy).not.toHaveBeenCalledWith(expect.objectContaining({ dbName: 'smoke' }));
  });

  it('falls back to test when the field is blank and the connection has no default', async () => {
    const listSpy = installListSpy();
    render(<ScriptTab tab={tab()} onPatch={() => {}} />);
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'test' }),
    );
  });

  // The collection list above is fed `effectiveDb` directly by ScriptTab, so it
  // cannot tell whether the same value also reached the editor. The editor
  // falls back to `test` on its own when it is handed a blank name, so the
  // sampling request is what proves the prop was wired.
  it("samples field names from the connection's default database when the DB field is blank", async () => {
    // Never settles: the request is recorded, and no completion popup (which
    // needs layout jsdom lacks) is ever rendered.
    const sampleSchema = vi.fn<IpcApi['meta']['sampleSchema']>(() => new Promise(() => {}));
    installAtelierMock({ meta: { sampleSchema } });
    const source = 'db.wiring.find({  })';
    render(
      <ScriptTab
        tab={tab({ state: { title: 't', source } })}
        defaultDb="smoke"
        onPatch={() => {}}
      />,
    );

    const editor = screen.getByTestId('script-editor').querySelector<HTMLElement>('.cm-editor');
    const view = EditorView.findFromDOM(editor!)!;
    view.dispatch({ selection: { anchor: source.indexOf('  })') + 1 } });
    startCompletion(view);

    await waitFor(() =>
      expect(sampleSchema).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'smoke',
        collection: 'wiring',
      }),
    );
    expect(sampleSchema).not.toHaveBeenCalledWith(expect.objectContaining({ dbName: 'test' }));
  });

  it('re-lists when the default database changes under a blank field', async () => {
    const listSpy = installListSpy();
    const { rerender } = render(<ScriptTab tab={tab()} defaultDb="smoke" onPatch={() => {}} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'smoke' }));
    rerender(<ScriptTab tab={tab()} defaultDb="other" onPatch={() => {}} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'other' }));
  });
});
