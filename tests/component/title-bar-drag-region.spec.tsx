import { describe, it, expect } from 'vitest';
import { render, screen } from '../helpers/render';
import { TitleBar } from '../../src/pages/Workspace/TitleBar';

const baseProps = {
  dark: false,
  toggle: () => {},
  connectionName: 'Local dev',
  onOpenSettings: () => {},
  onOpenPalette: () => {},
  shellOpen: false,
  shellAvailable: true,
  onToggleShell: () => {},
};

const region = (el: HTMLElement) => (el.style as unknown as Record<string, string>).WebkitAppRegion;

describe('TitleBar drag region', () => {
  it('the plain breadcrumb text sits in the window drag area', () => {
    render(<TitleBar {...baseProps} />);
    const text = screen.getByText('Local dev');
    expect(region(text.parentElement as HTMLElement)).toBe('drag');
    expect(text.closest('[style*="no-drag"]')).toBeNull();
  });

  it('the connection switcher slot opts out of dragging so it stays clickable', () => {
    render(<TitleBar {...baseProps} connectionSlot={<button type="button">Switch</button>} />);
    const button = screen.getByRole('button', { name: 'Switch' });
    expect(region(button.parentElement as HTMLElement)).toBe('no-drag');
    expect(region(button.parentElement!.parentElement as HTMLElement)).toBe('drag');
  });

  it('the slot wrapper stays a shrinkable flex box so the switcher can still ellipsize', () => {
    render(<TitleBar {...baseProps} connectionSlot={<button type="button">Switch</button>} />);
    const wrapper = screen.getByRole('button', { name: 'Switch' }).parentElement as HTMLElement;
    expect(wrapper.style.display).toBe('flex');
    expect(wrapper.style.flexGrow).toBe('1');
    expect(wrapper.style.minWidth).toBe('0px');
  });
});
