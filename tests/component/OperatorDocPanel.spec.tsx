import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import { notifications } from '@mantine/notifications';
import { render, screen, fireEvent } from '../helpers/render';
import { OperatorDocPanel } from '../../src/features/fieldSuggestions/OperatorDocPanel';
import type { OperatorDef } from '../../src/features/fieldSuggestions/operators';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

const FULL: OperatorDef = {
  name: '$match',
  class: 'stage',
  summary: 'Filter documents',
  description: 'Filters the pipeline so that only documents matching the query pass.',
  syntax: '{ $match: <query> }',
  example: '{ $match: { status: "active" } }',
  url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
};

describe('OperatorDocPanel', () => {
  let openExternalSpy: Mock<IpcApi['shell']['openExternal']>;

  beforeEach(() => {
    openExternalSpy = vi.fn(async () => ({ opened: true as const }));
    installAtelierMock({
      shell: { openExternal: openExternalSpy },
    });
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  it('renders every section when the operator is fully populated', () => {
    render(<OperatorDocPanel op={FULL} />);
    expect(screen.getByText('$match')).toBeTruthy();
    expect(screen.getByText(/Filters the pipeline/)).toBeTruthy();
    expect(screen.getByText('Syntax')).toBeTruthy();
    expect(screen.getByText('{ $match: <query> }')).toBeTruthy();
    expect(screen.getByText('Example')).toBeTruthy();
    expect(screen.getByText(/Class: stage operator/)).toBeTruthy();
    expect(screen.getByText(/Learn more/)).toBeTruthy();
  });

  it('omits the Learn more link when url is absent', () => {
    const { url, ...noUrl } = FULL;
    void url;
    render(<OperatorDocPanel op={noUrl as OperatorDef} />);
    expect(screen.queryByText(/Learn more/)).toBeNull();
  });

  it('omits the Example block when example is absent', () => {
    const { example, ...noExample } = FULL;
    void example;
    render(<OperatorDocPanel op={noExample as OperatorDef} />);
    expect(screen.queryByText('Example')).toBeNull();
  });

  it('omits the Syntax block when syntax is absent', () => {
    const { syntax, ...noSyntax } = FULL;
    void syntax;
    render(<OperatorDocPanel op={noSyntax as OperatorDef} />);
    expect(screen.queryByText('Syntax')).toBeNull();
  });

  it('renders a placeholder when op is null', () => {
    render(<OperatorDocPanel op={null} />);
    expect(screen.getByText(/No documentation available/)).toBeTruthy();
  });

  it('routes the Learn more click through window.atelier.shell.openExternal', () => {
    render(<OperatorDocPanel op={FULL} />);
    const link = screen.getByText(/Learn more/);
    fireEvent.click(link);
    expect(openExternalSpy).toHaveBeenCalledWith({ url: FULL.url });
  });

  it('renders aria-label describing the operator', () => {
    render(<OperatorDocPanel op={FULL} />);
    expect(screen.getByLabelText('Documentation for $match')).toBeTruthy();
  });
});

describe('OperatorDocPanel — a docs link that cannot open says so', () => {
  afterEach(() => {
    uninstallAtelierMock();
    notifications.clean();
  });

  it('toasts when the link cannot be opened', async () => {
    installAtelierMock({
      shell: {
        openExternal: async () => {
          throw { code: 'VALIDATION', message: 'blocked' };
        },
      },
    });
    render(<OperatorDocPanel op={FULL} />);

    fireEvent.click(screen.getByText(/Learn more/));

    expect(await screen.findByText('Could not open the link')).toBeTruthy();
  });
});
