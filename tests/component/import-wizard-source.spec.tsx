import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen } from '../helpers/render';
import { SourceStep } from '../../src/features/connections/importWizard/SourceStep';

function setup(over: Partial<React.ComponentProps<typeof SourceStep>> = {}) {
  const onFile = vi.fn();
  const onUris = vi.fn();
  render(<SourceStep initial="file" busy={false} onFile={onFile} onUris={onUris} {...over} />);
  return { onFile, onUris };
}

// `fireEvent.change`: a connection string is pasted, not typed key by key.
const paste = (text: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: /paste connection strings/i }), { target: { value: text } });
const next = () => screen.getByRole('button', { name: 'Next' });

describe('SourceStep', () => {
  it('calls onFile from the Choose file button', async () => {
    const { onFile } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('sends the trimmed, non-blank lines to onUris', async () => {
    const { onUris } = setup();
    paste('  mongodb://a  \n\r\n\nmongodb://b\n');
    await userEvent.click(next());
    expect(onUris).toHaveBeenCalledWith(['mongodb://a', 'mongodb://b']);
  });

  it('counts lines, ignoring blanks, and disables Next on none', () => {
    setup();
    expect(screen.getByText('0 / 100 lines')).toBeTruthy();
    expect((next() as HTMLButtonElement).disabled).toBe(true);
    paste('a\n\nb');
    expect(screen.getByText('2 / 100 lines')).toBeTruthy();
    expect((next() as HTMLButtonElement).disabled).toBe(false);
  });

  it('accepts exactly 100 lines and refuses 101', () => {
    setup();
    paste(Array.from({ length: 100 }, (_, i) => `mongodb://h${i}`).join('\n'));
    expect((next() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Up to 100 connection strings at a time.')).toBeNull();
    paste(Array.from({ length: 101 }, (_, i) => `mongodb://h${i}`).join('\n'));
    expect(screen.getByText('Up to 100 connection strings at a time.')).toBeTruthy();
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it('accepts a 4096-character line and refuses 4097, naming the line', () => {
    const { onUris } = setup();
    paste(`ok\n${'x'.repeat(4096)}`);
    expect((next() as HTMLButtonElement).disabled).toBe(false);
    paste(`ok\n${'x'.repeat(4097)}`);
    expect(screen.getByText('Line 2 is longer than 4,096 characters.')).toBeTruthy();
    expect((next() as HTMLButtonElement).disabled).toBe(true);
    expect(onUris).not.toHaveBeenCalled();
  });

  it('focuses the file button or the paste box according to initial', () => {
    const { unmount } = render(<SourceStep initial="file" busy={false} onFile={vi.fn()} onUris={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose file…' }));
    unmount();
    render(<SourceStep initial="paste" busy={false} onFile={vi.fn()} onUris={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /paste connection strings/i }));
  });

  it('shows the error from main and disables Next while busy', () => {
    setup({ busy: true, error: "This isn't a JSON file." });
    expect(screen.getByRole('alert').textContent).toBe("This isn't a JSON file.");
    paste('mongodb://a');
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    const { onFile, onUris } = setup({ initial: 'paste' });
    await user.type(screen.getByRole('textbox', { name: /paste connection strings/i }), 'mongodb://a');
    await user.tab();
    expect(document.activeElement).toBe(next());
    await user.keyboard('{Enter}');
    expect(onUris).toHaveBeenCalledWith(['mongodb://a']);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose file…' }));
    await user.keyboard(' ');
    expect(onFile).toHaveBeenCalledTimes(1);
  });
});
