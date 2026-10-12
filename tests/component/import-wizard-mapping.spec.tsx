import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { MapTarget, MappingCollection } from '@shared/types';
import { render, screen } from '../helpers/render';
import { MappingStep } from '../../src/features/connections/importWizard/MappingStep';

const servers: MappingCollection = {
  at: 'servers',
  rows: 3,
  fields: [
    { path: 'label', sample: 'Prod', masked: false, suggested: 'name' },
    { path: 'uri', sample: 'mongodb://h', masked: false, suggested: 'connectionString' },
    { path: 'secret', sample: '••••', masked: true, suggested: 'password' },
    { path: 'hostname', sample: 'h1', masked: false },
  ],
};
const other: MappingCollection = {
  at: 'data.items',
  rows: 1,
  fields: [{ path: 'server', sample: 'h2', masked: false, suggested: 'host' }],
};

function setup(collections: MappingCollection[] = [servers], busy = false) {
  const onBack = vi.fn();
  const onNext = vi.fn();
  render(<MappingStep collections={collections} busy={busy} onBack={onBack} onNext={onNext} />);
  return { onBack, onNext };
}
const select = (path: string) => screen.getByRole('combobox', { name: `Use ${path} as` }) as HTMLSelectElement;
const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
const pick = (path: string, target: MapTarget | '') => userEvent.selectOptions(select(path), target);

describe('MappingStep', () => {
  it('lists targets in the C14 order, with a clear option first', () => {
    setup();
    expect(Array.from(select('label').options).map((o) => o.textContent)).toEqual([
      '—', 'Name', 'Connection string', 'Host', 'Port', 'Username', 'Password',
      'Auth database', 'Default database', 'TLS',
    ]);
  });

  it('pre-fills each select from the suggestions', () => {
    setup();
    expect(select('label').value).toBe('name');
    expect(select('uri').value).toBe('connectionString');
    expect(select('secret').value).toBe('password');
    expect(select('hostname').value).toBe('');
  });

  it('masks a secret sample with the hint, and shows others as they are', () => {
    setup();
    expect(screen.getByText('Taken from the file — not shown')).toBeTruthy();
    expect(screen.getAllByText('••••')).toHaveLength(1);
    expect(screen.getByText('Prod')).toBeTruthy();
  });

  it('shows the connection string with its secrets stripped, and hides a field with no such sample', () => {
    setup([{ ...servers, fields: [
      { path: 'cs', sample: 'mongodb://alice@h/?tls=true', masked: true, suggested: 'connectionString' },
      { path: 'secret', sample: '••••', masked: true },
    ] }]);
    expect(screen.getByText('mongodb://alice@h/?tls=true')).toBeTruthy();
    expect(screen.getAllByText('••••')).toHaveLength(1);
    expect(screen.getAllByText('Taken from the file — not shown')).toHaveLength(1);
  });

  it('disables Back and Next while busy', async () => {
    const { onBack, onNext } = setup([servers], true);
    expect(next().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('moves a target that another field already holds', async () => {
    setup();
    await pick('hostname', 'name');
    expect(select('hostname').value).toBe('name');
    expect(select('label').value).toBe('');
  });

  it('clears a mapping with the dash option', async () => {
    setup();
    await pick('uri', '');
    expect(select('uri').value).toBe('');
    expect(next().disabled).toBe(true);
  });

  it('enables Next for a connection string, for a host, and not for neither', async () => {
    setup();
    expect(next().disabled).toBe(false);
    await pick('uri', '');
    expect(next().disabled).toBe(true);
    await pick('label', 'host');
    expect(next().disabled).toBe(false);
  });

  it('sends the collection path and the target-to-path mapping', async () => {
    const { onNext } = setup();
    await pick('hostname', 'host');
    await userEvent.click(next());
    expect(onNext).toHaveBeenCalledWith('servers', {
      name: 'label',
      connectionString: 'uri',
      password: 'secret',
      host: 'hostname',
    });
  });

  it('calls onBack', async () => {
    const { onBack } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hides the collection picker when there is one collection', () => {
    setup();
    expect(screen.queryByRole('combobox', { name: 'Connections are listed in' })).toBeNull();
  });

  it('switching collection resets to that collection\'s suggestions', async () => {
    const { onNext } = setup([servers, other]);
    const picker = screen.getByRole('combobox', { name: 'Connections are listed in' }) as HTMLSelectElement;
    expect(picker.value).toBe('servers');
    await pick('hostname', 'host');
    await userEvent.selectOptions(picker, 'data.items');
    expect(screen.queryByRole('combobox', { name: 'Use hostname as' })).toBeNull();
    expect(select('server').value).toBe('host');
    await userEvent.selectOptions(picker, 'servers');
    expect(select('hostname').value).toBe('');
    expect(select('uri').value).toBe('connectionString');
    await userEvent.click(next());
    expect(onNext).toHaveBeenCalledWith('servers', { name: 'label', connectionString: 'uri', password: 'secret' });
  });

  it('reports how many rows were left out', () => {
    setup([{ ...servers, truncatedRows: 120 }]);
    expect(screen.getByText(/Only the first 500 rows are read/)).toBeTruthy();
  });

  it('says how many paths of lists and of fields were left out as ambiguous, and nothing when none were', () => {
    const { unmount } = render(
      <MappingStep collections={[{ ...servers, ambiguousFields: 2 }]} ambiguousCollections={1} onBack={vi.fn()} onNext={vi.fn()} />,
    );
    expect(screen.getByText(/Some lists are left out: 1 path names more than one list/)).toBeTruthy();
    expect(screen.getByText(/Some fields are left out: 2 paths name more than one value in a row/)).toBeTruthy();
    unmount();
    setup();
    expect(screen.queryByText(/left out:/)).toBeNull();
  });

  it('gives a target to only the first of two fields suggesting it', () => {
    setup([{ ...servers, fields: [
      { path: 'a.host', sample: 'x', masked: false, suggested: 'host' },
      { path: 'b.host', sample: 'y', masked: false, suggested: 'host' },
    ] }]);
    expect(select('a.host').value).toBe('host');
    expect(select('b.host').value).toBe('');
  });

  it('keeps a __proto__ or constructor field as data: suggested, chosen and sent', async () => {
    // Paths are file keys; a plain-object assignment would hit Object.prototype for these two.
    // `constructor` would read Object as its target, which React refuses as a select value.
    const consoleError = vi.spyOn(console, 'error');
    const { onNext } = setup([{ at: '', rows: 1, fields: [
      { path: '__proto__', sample: 'mongodb://h', masked: false, suggested: 'connectionString' },
      { path: 'constructor', sample: 'Prod', masked: false },
    ] }]);
    expect(select('__proto__').value).toBe('connectionString');
    expect(select('constructor').value).toBe('');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Invalid value for prop');
    consoleError.mockRestore();
    expect(next().disabled).toBe(false);
    await userEvent.click(next());
    expect(onNext).toHaveBeenLastCalledWith('', { connectionString: '__proto__' });

    await pick('__proto__', '');
    expect(next().disabled).toBe(true);
    await pick('__proto__', 'host');
    await pick('constructor', 'name');
    expect(select('__proto__').value).toBe('host');
    expect(select('constructor').value).toBe('name');
    expect(next().disabled).toBe(false);
    await userEvent.click(next());
    expect(onNext).toHaveBeenLastCalledWith('', { host: '__proto__', name: 'constructor' });
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    const { onNext } = setup();
    await user.click(select('secret'));
    await user.tab();
    expect(document.activeElement).toBe(select('hostname'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }));
    await user.tab();
    expect(document.activeElement).toBe(next());
    await user.keyboard('{Enter}');
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
