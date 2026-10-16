import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ImportWizard } from '../../src/features/connections/importWizard/ImportWizard';
import * as connectionsState from '../../src/state/connections';
import type {
  ImportCommitInput,
  ImportCommitResult,
  ImportMapInput,
  ImportMapResult,
  ImportOpenResult,
  ImportUrisResult,
  MappingCollection,
  Review,
} from '@shared/types';

const HINT =
  'Connects to this one host only. Turn off if this is one member of a replica set and you want the other members discovered.';

/** A Compass-like review: a sealed password, an SRV row asking for credentials, an unticked multi-host recent, an OIDC row. */
const REVIEW: Review = {
  hasEncryptedSecrets: true,
  rows: [
    {
      index: 0, ok: true, savedAs: 'Prod', host: 'prod.example.com', port: 27017, srv: false,
      authUsername: 'alice', hasPassword: true, passwordSealed: true, needsCredentials: false,
      directConnection: true, defaultTicked: true, repick: ['tlsCa'], warnings: ['FLE options were dropped.'],
      tls: true, defaultDb: 'app', ssh: false,
    },
    {
      index: 1, ok: true, savedAs: 'Cluster', host: 'cluster0.example.net', srv: true,
      hasPassword: false, passwordSealed: false, needsCredentials: true,
      directConnection: null, defaultTicked: true, repick: [], warnings: [],
      tls: true, ssh: false,
    },
    {
      index: 2, ok: true, savedAs: 'Recent', host: 'recent.example.com', port: 27018, srv: false,
      hasPassword: false, passwordSealed: false, needsCredentials: false,
      directConnection: false, defaultTicked: false, repick: [], warnings: ['Only the first host was kept.'],
      tls: false, ssh: true,
    },
    { index: 3, ok: false, reason: "OIDC sign-in isn't supported yet." },
  ],
};

const PLAIN: Review = {
  hasEncryptedSecrets: false,
  rows: [
    {
      index: 0, ok: true, savedAs: 'db1.example.com', host: 'db1.example.com', port: 27017, srv: false,
      hasPassword: false, passwordSealed: false, needsCredentials: false,
      directConnection: true, defaultTicked: true, repick: [], warnings: [], tls: false, ssh: false,
    },
  ],
};

const COLLECTIONS: MappingCollection[] = [
  {
    at: 'servers',
    rows: 2,
    fields: [
      { path: 'label', sample: 'Prod', masked: false, suggested: 'name' },
      { path: 'uri', sample: 'mongodb://h', masked: false, suggested: 'connectionString' },
      { path: 'db', sample: 'app', masked: false },
    ],
  },
];

const RESULT: ImportCommitResult = {
  created: [
    { index: 0, id: 'n1', name: 'Prod (2)' },
    { index: 1, id: 'n2', name: 'Cluster' },
  ],
  renamed: [{ index: 0, from: 'Prod', to: 'Prod (2)' }],
  skipped: [{ index: 2, name: 'Recent', reason: 'Port must be between 1 and 65535.' }],
  repick: [{ name: 'Prod (2)', files: ['tlsCa', 'sshKey'] }],
  secretsNotStored: [{ name: 'Cluster', reason: 'secure storage is unavailable' }],
  warnings: [{ name: 'Prod (2)', message: 'The Compass secret "awsSessionToken" was not imported.' }],
};

function setup(opts: {
  open?: ImportOpenResult | Error;
  commit?: (i: ImportCommitInput) => Promise<ImportCommitResult>;
  map?: (i: ImportMapInput) => Promise<ImportMapResult>;
  initial?: 'file' | 'paste';
} = {}) {
  const importOpen = vi.fn(async (): Promise<ImportOpenResult> => {
    if (opts.open instanceof Error) throw opts.open;
    return opts.open ?? { token: 'tok', source: 'compass', review: REVIEW };
  });
  const importMap = vi.fn<(i: ImportMapInput) => Promise<ImportMapResult>>(opts.map ?? (async () => ({ review: PLAIN })));
  const importUris = vi.fn<(u: string[]) => Promise<ImportUrisResult>>(async () => ({ token: 'tok-u', review: PLAIN }));
  const importCommit = vi.fn<(i: ImportCommitInput) => Promise<ImportCommitResult>>(opts.commit ?? (async () => RESULT));
  installAtelierMock({ conn: { importOpen, importMap, importUris, importCommit } });
  const changed = vi.spyOn(connectionsState, 'notifyConnectionsChanged');
  const onClose = vi.fn();
  render(<ImportWizard initial={opts.initial ?? 'file'} onClose={onClose} />);
  return { importOpen, importMap, importUris, importCommit, changed, onClose };
}

const chooseFile = () => userEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
const reviewTable = () => screen.findByRole('table', { name: 'Connections to import' });
const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const importButton = () => screen.getByRole('button', { name: /^Import( \d+ Connections?)?$/ }) as HTMLButtonElement;
const badPassphrase = () =>
  Object.assign(new Error('Wrong passphrase for this Compass export.'), { code: 'BAD_PASSPHRASE' });

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Import Wizard: source routing', () => {
  it.each(['latelier', 'compass'] as const)('a %s export goes straight to the final approval', async (source) => {
    const { importMap } = setup({ open: { token: 'tok', source, review: REVIEW } });
    await chooseFile();
    await reviewTable();
    expect(screen.queryByRole('table', { name: 'Fields in the file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(importMap).not.toHaveBeenCalled();
  });

  it('Field Mapping holds Back and Next while the mapping is being applied', async () => {
    let finish!: (r: ImportMapResult) => void;
    const { importMap } = setup({
      open: { token: 'tok-j', source: 'unknown', collections: COLLECTIONS },
      map: () => new Promise<ImportMapResult>((resolve) => (finish = resolve)),
    });
    await chooseFile();
    await screen.findByRole('table', { name: 'Fields in the file' });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(importMap).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    finish({ review: PLAIN });
    await reviewTable();
  });

  it('Field Mapping says how many paths main left out because two lists share them', async () => {
    setup({ open: { token: 'tok-j', source: 'unknown', collections: COLLECTIONS, ambiguousCollections: 2 } });
    await chooseFile();
    expect(await screen.findByText(/Some lists are left out: 2 paths name more than one list/)).toBeTruthy();
  });

  it('an unknown JSON file goes through Field Mapping, and Back from the review keeps the choices', async () => {
    const { importMap } = setup({ open: { token: 'tok-j', source: 'unknown', collections: COLLECTIONS } });
    await chooseFile();
    await screen.findByRole('table', { name: 'Fields in the file' });
    expect(screen.queryByRole('table', { name: 'Connections to import' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Use db as' }), { target: { value: 'defaultDb' } });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    await reviewTable();
    expect(importMap).toHaveBeenCalledWith({
      token: 'tok-j',
      at: 'servers',
      mapping: { name: 'label', connectionString: 'uri', defaultDb: 'db' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect((screen.getByRole('combobox', { name: 'Use db as' }) as HTMLSelectElement).value).toBe('defaultDb');
    expect(screen.queryByRole('table', { name: 'Connections to import' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await reviewTable();
    expect(importMap).toHaveBeenCalledTimes(2);
    expect(importMap.mock.calls[1]![0].token).toBe('tok-j');
  });

  it('pasted connection strings go to importUris and on to the final approval', async () => {
    const { importUris, importOpen } = setup({ initial: 'paste' });
    fireEvent.change(screen.getByRole('textbox', { name: /paste connection strings/i }), {
      target: { value: 'mongodb://db1.example.com\nmongodb://db2.example.com' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await reviewTable();
    expect(importUris).toHaveBeenCalledWith(['mongodb://db1.example.com', 'mongodb://db2.example.com']);
    expect(importOpen).not.toHaveBeenCalled();
  });

  it('a cancelled file picker stays on the source with no error', async () => {
    const { importOpen } = setup({ open: { cancelled: true } });
    await chooseFile();
    await waitFor(() => expect(importOpen).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Choose file…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a file main refuses shows its reason on the source', async () => {
    setup({ open: Object.assign(new Error("This isn't a JSON file."), { code: 'VALIDATION' }) });
    await chooseFile();
    expect((await screen.findByRole('alert')).textContent).toContain("This isn't a JSON file.");
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
  });
});

describe('Import Wizard: final approval', () => {
  it('starts from each row’s defaults and lists the unusable row with its reason, untickable', async () => {
    setup();
    await chooseFile();
    const table = await reviewTable();
    expect(box('Import Prod').checked).toBe(true);
    expect(box('Import Cluster').checked).toBe(true);
    expect(box('Import Recent').checked).toBe(false);
    expect(box('Import row 4').disabled).toBe(true);
    expect(within(table).getByText("Not importable: OIDC sign-in isn't supported yet.")).toBeTruthy();

    expect(box('Direct connection for Prod').checked).toBe(true);
    expect(box('Direct connection for Recent').checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: 'Direct connection for Cluster' })).toBeNull();
    expect(screen.getByText(`Direct connection: ${HINT}`)).toBeTruthy();

    expect(within(table).getByText('prod.example.com:27017')).toBeTruthy();
    expect(within(table).getByText('cluster0.example.net')).toBeTruthy();
    expect(within(table).getByText('TLS on · SSH off · db app')).toBeTruthy();
    expect(within(table).getByText('TLS off · SSH on')).toBeTruthy();
    expect(within(table).getByText('re-pick CA file · FLE options were dropped.')).toBeTruthy();
  });

  it('asks for credentials on ticked rows that need them, and on sealed rows once imported without passwords', async () => {
    setup();
    await chooseFile();
    await reviewTable();
    // Cluster has no password at all; Prod's is sealed behind the passphrase.
    expect(screen.getByRole('textbox', { name: 'Username for Cluster' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Username for Prod' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Username for Recent' })).toBeNull();

    await userEvent.click(box('Import without passwords'));
    expect((screen.getByRole('textbox', { name: 'Username for Prod' }) as HTMLInputElement).value).toBe('alice');
    expect((screen.getByLabelText('Export Passphrase') as HTMLInputElement).disabled).toBe(true);

    await userEvent.click(box('Import without passwords'));
    expect(screen.queryByRole('textbox', { name: 'Username for Prod' })).toBeNull();

    await userEvent.click(box('Import Cluster'));
    expect(screen.queryByRole('textbox', { name: 'Username for Cluster' })).toBeNull();
  });

  it.each([
    ['latelier', false],
    ['compass', true],
  ] as const)('the batch Read-only for a %s export: offered=%s, off by default', async (source, offered) => {
    setup({ open: { token: 'tok', source, review: REVIEW } });
    await chooseFile();
    await reviewTable();
    const readOnly = screen.queryByRole('checkbox', { name: 'Read-only, for all rows' }) as HTMLInputElement | null;
    expect(readOnly !== null).toBe(offered);
    if (readOnly) expect(readOnly.checked).toBe(false);
  });

  it('keeps Import disabled with nothing ticked or without a passphrase', async () => {
    setup();
    await chooseFile();
    await reviewTable();
    expect(importButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'pp');
    expect(importButton().disabled).toBe(false);
    await userEvent.click(box('Import Prod'));
    await userEvent.click(box('Import Cluster'));
    expect(importButton().disabled).toBe(true);
  });

  it('refuses a password without a username', async () => {
    setup();
    await chooseFile();
    await reviewTable();
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'pp');
    await userEvent.type(screen.getByLabelText('Password for Cluster'), 'pw');
    expect(screen.getByText('Add a username for this password.')).toBeTruthy();
    expect(importButton().disabled).toBe(true);
  });
});

describe('Import Wizard: commit', () => {
  it('sends exactly the ticked rows, every ticked non-SRV Direct connection, typed credentials, Read-only and the passphrase', async () => {
    const { importCommit } = setup();
    await chooseFile();
    await reviewTable();
    await userEvent.click(box('Import Recent'));
    await userEvent.click(box('Direct connection for Prod'));
    await userEvent.click(box('Direct connection for Recent'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for Cluster' }), ' bob ');
    await userEvent.type(screen.getByLabelText('Password for Cluster'), 'pw');
    await userEvent.click(box('Read-only, for all rows'));
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'secret phrase');
    await userEvent.click(importButton());

    await waitFor(() => expect(importCommit).toHaveBeenCalledTimes(1));
    expect(importCommit.mock.calls[0]![0]).toEqual({
      token: 'tok',
      indices: [0, 1, 2],
      readOnly: true,
      directConnection: [
        { index: 0, value: false },
        { index: 2, value: true },
      ],
      credentials: [{ index: 1, username: 'bob', password: 'pw' }],
      passphrase: 'secret phrase',
    });
  });

  it('imports without passwords: no passphrase, credentials only for rows typed in and still shown', async () => {
    const { importCommit } = setup();
    await chooseFile();
    await reviewTable();
    await userEvent.click(box('Import without passwords'));
    await userEvent.type(screen.getByLabelText('Password for Prod'), 'new-pw');
    // Typed, then unticked: nothing of it may be sent.
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for Cluster' }), 'carol');
    await userEvent.click(box('Import Cluster'));
    await userEvent.click(importButton());

    await waitFor(() => expect(importCommit).toHaveBeenCalledTimes(1));
    expect(importCommit.mock.calls[0]![0]).toEqual({
      token: 'tok',
      indices: [0],
      readOnly: false,
      directConnection: [{ index: 0, value: true }],
      credentials: [{ index: 0, username: 'alice', password: 'new-pw' }],
      withoutSecrets: true,
    });
  });

  it('notes the original name only on rows renamed by a clash', async () => {
    const [prod, ...rest] = REVIEW.rows;
    if (!prod?.ok) throw new Error('fixture: first row must be ok');
    setup({
      open: {
        token: 'tok',
        source: 'compass',
        review: { ...REVIEW, rows: [{ ...prod, savedAs: 'Prod (2)', renamedFrom: 'Prod' }, ...rest] },
      },
    });
    await chooseFile();
    await reviewTable();
    expect(screen.getAllByText(/^renamed from /).map((n) => n.textContent)).toEqual(['renamed from "Prod"']);
  });

  it('keeps the review on a wrong passphrase and retries on the same token', async () => {
    let calls = 0;
    const { importCommit, changed } = setup({
      commit: async () => {
        calls += 1;
        if (calls === 1) throw badPassphrase();
        return RESULT;
      },
    });
    await chooseFile();
    await reviewTable();
    await userEvent.click(box('Import Recent'));
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'wrong');
    await userEvent.click(importButton());

    expect(await screen.findByText('Wrong passphrase for this Compass export.')).toBeTruthy();
    expect(box('Import Recent').checked).toBe(true);
    expect(changed).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Export Passphrase'));
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'right');
    await userEvent.click(importButton());

    await screen.findByText('2 Connections imported.');
    expect(importCommit.mock.calls.map((c) => [c[0].token, c[0].passphrase, c[0].indices])).toEqual([
      ['tok', 'wrong', [0, 1, 2]],
      ['tok', 'right', [0, 1, 2]],
    ]);
  });

  it('shows any other failure on the review and refreshes the list', async () => {
    const { changed } = setup({
      commit: async () => {
        throw Object.assign(new Error('Disk full'), { code: 'SYSTEM' });
      },
    });
    await chooseFile();
    await reviewTable();
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'pp');
    await userEvent.click(importButton());

    expect((await screen.findByRole('alert')).textContent).toBe('Disk full');
    expect(screen.getByRole('table', { name: 'Connections to import' })).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('shows the result, refreshes the Connections list, and Done closes', async () => {
    const { changed, onClose } = setup();
    await chooseFile();
    await reviewTable();
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'pp');
    await userEvent.click(importButton());

    expect(await screen.findByText('2 Connections imported.')).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
    const items = (label: string) =>
      within(screen.getByRole('list', { name: label })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items('Connections not imported')).toEqual(['Recent: Port must be between 1 and 65535.']);
    expect(items('Renamed Connections')).toEqual(['Prod → Prod (2)']);
    expect(items('Files to pick again')).toEqual(['Prod (2): re-pick CA file, re-pick SSH key']);
    expect(items('Secrets not stored')).toEqual(['Cluster: secure storage is unavailable']);
    expect(items('Warnings')).toEqual(['Prod (2): The Compass secret "awsSessionToken" was not imported.']);

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
