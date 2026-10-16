/**
 * Shortcuts that work without being palette commands, so the registry cannot
 * list them, grouped by where they work. Written in Mac glyphs like
 * `Command.shortcut`; the cheat sheet formats them for the platform.
 */
export const STATIC_SHORTCUTS: ReadonlyArray<{
  section: string;
  items: ReadonlyArray<{ keys: string; title: string }>;
}> = [
  {
    section: 'Anywhere',
    items: [{ keys: '⌘K', title: 'Open the command palette' }],
  },
  {
    // Bound by the workspace screen, so dead on the connection form.
    section: 'In the workspace',
    items: [
      { keys: '⌘1–9', title: 'Switch to the 1st to 9th tab' },
      { keys: '⌘⌥←', title: 'Previous tab' },
      { keys: '⌘⌥→', title: 'Next tab' },
      { keys: '⌘E', title: 'Manage connections' },
    ],
  },
  {
    section: 'In the connection form',
    items: [
      { keys: '⌘S', title: 'Save connection' },
      { keys: '⌘↵', title: 'Test connection' },
    ],
  },
];
