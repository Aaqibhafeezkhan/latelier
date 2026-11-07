import { describe, expect, it } from 'vitest';
import { Badge, Button, SegmentedControl, Select, TextInput } from '@mantine/core';
import { render, screen } from '../helpers/render';

/**
 * One density, set once in the theme. These read the CSS variables Mantine writes
 * inline, which is what jsdom can see; the sizes are measured in the app by
 * tests/e2e/results-toolbar-no-clip.e2e.ts.
 */
// The 13 px label size is the md type token, so a control reads it from index.css.
const FS_MD = 'var(--atelier-fs-md)';
const FS_XS = 'var(--atelier-fs-xs)';

describe('theme control sizes', () => {
  const buttonVar = (name: string, v: string) =>
    (screen.getByRole('button', { name }) as HTMLElement).style.getPropertyValue(v);

  it('compact buttons are 26 px with 13 px labels', () => {
    render(
      <>
        <Button size="compact-xs">a</Button>
        <Button size="compact-sm">b</Button>
      </>,
    );
    for (const name of ['a', 'b']) {
      expect(buttonVar(name, '--button-height')).toBe('26px');
      expect(buttonVar(name, '--button-fz')).toBe(FS_MD);
    }
  });

  it('regular buttons are 36 px with 13 px labels', () => {
    render(
      <>
        <Button size="xs">a</Button>
        <Button>b</Button>
      </>,
    );
    expect(buttonVar('a', '--button-height')).toBe('36px');
    expect(buttonVar('a', '--button-fz')).toBe(FS_MD);
    // The default size is already 36 px tall; only its label needs the override.
    expect(buttonVar('b', '--button-fz')).toBe(FS_MD);
  });

  it('an explicit size the theme does not list is left alone', () => {
    render(<Button size="lg">a</Button>);
    expect(buttonVar('a', '--button-fz')).not.toBe(FS_MD);
  });

  it('inputs of every kind reach 36 px with 13 px text through the one Input entry', () => {
    const { container } = render(
      <>
        <TextInput size="xs" aria-label="text" />
        <Select size="xs" aria-label="select" data={['x']} />
        <TextInput aria-label="plain" />
      </>,
    );
    const wrapperOf = (label: string) =>
      container.querySelector(`input[aria-label="${label}"]`)!.closest('.mantine-Input-wrapper') as HTMLElement;
    for (const label of ['text', 'select']) {
      expect(wrapperOf(label).style.getPropertyValue('--input-height')).toBe('36px');
      expect(wrapperOf(label).style.getPropertyValue('--input-fz')).toBe(FS_MD);
    }
    expect(wrapperOf('plain').style.getPropertyValue('--input-fz')).toBe(FS_MD);
  });

  it('the small segmented control lines up with a compact button', () => {
    const { container } = render(<SegmentedControl size="xs" data={['Tree', 'JSON']} />);
    const root = container.querySelector('.mantine-SegmentedControl-root') as HTMLElement;
    expect(root.style.getPropertyValue('--sc-font-size')).toBe(FS_MD);
    expect(root.style.getPropertyValue('--sc-padding')).toBe('1px 8px');
    expect(root.style.padding).toBe('2px');
  });

  // Mantine's named sizes would otherwise dip under the 11 px floor: Badge xs and sm are
  // 9 and 10 px, and an xs input's description and error 10 px.
  it('badges xs and sm hold the 11 px floor, and the larger ones are left alone', () => {
    render(
      <>
        <Badge size="xs">a</Badge>
        <Badge size="sm">b</Badge>
        <Badge size="md">c</Badge>
      </>,
    );
    const fz = (text: string) => (screen.getByText(text).closest('.mantine-Badge-root') as HTMLElement).style.getPropertyValue('--badge-fz');
    expect(fz('a')).toBe(FS_XS);
    expect(fz('b')).toBe(FS_XS);
    expect(fz('c')).toBe('var(--badge-fz-md)');
  });

  it('an xs input holds the floor for its description and error', () => {
    render(<TextInput size="xs" label="Name" description="the description" error="the error" />);
    const sized = (text: string, v: string) => (screen.getByText(text) as HTMLElement).style.getPropertyValue(v);
    expect(sized('the description', '--input-description-size')).toBe(FS_XS);
    expect(sized('the error', '--input-error-size')).toBe(FS_XS);
  });
});
