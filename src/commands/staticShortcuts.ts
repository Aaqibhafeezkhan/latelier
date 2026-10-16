/**
 * Shortcuts that work without being palette commands, so the registry cannot
 * list them. Written in Mac glyphs like `Command.shortcut`; the cheat sheet
 * formats them for the platform.
 */
export const STATIC_SHORTCUTS: ReadonlyArray<{ keys: string; title: string }> = [
  { keys: '⌘K', title: 'Open the command palette' },
  { keys: '⌘1–9', title: 'Switch to the 1st to 9th tab' },
  { keys: '⌘⌥←', title: 'Previous tab' },
  { keys: '⌘⌥→', title: 'Next tab' },
  { keys: '⌘E', title: 'Manage connections' },
];
