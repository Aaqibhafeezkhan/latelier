// Windows/Linux modifier order, whichever order the Mac glyphs were written in.
const MODIFIERS = [
  ['⌘', 'Ctrl'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift'],
] as const;

/**
 * Shortcuts are written once in Mac glyphs (`⌘T`, `⇧⌘↵`). On a Mac they show as
 * written; elsewhere they show as `Ctrl+T`, `Ctrl+Shift+Enter`. Only leading
 * glyphs are modifiers, so a label without any passes through unchanged.
 */
export function formatShortcut(label: string, mac: boolean): string {
  if (mac) return label;
  let rest = label;
  const held = new Set<string>();
  const leading = () => MODIFIERS.find(([glyph]) => rest.startsWith(glyph));
  for (let hit = leading(); hit; hit = leading()) {
    held.add(hit[1]);
    rest = rest.slice(hit[0].length);
  }
  const key = rest.replaceAll('↵', 'Enter');
  return [...MODIFIERS.map(([, name]) => name).filter((n) => held.has(n)), key]
    .filter((part) => part !== '')
    .join('+');
}
