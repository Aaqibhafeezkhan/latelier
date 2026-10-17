import React from 'react';
import { ActionIcon, Button, Group, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { formatShortcut } from '../../commands/shortcutLabel';
import { isMacRenderer } from '../../utils/platform';

interface TitleBarProps {
  dark: boolean;
  toggle: () => void;
  connectionName: string | null;
  /**
   * Renders in place of the plain Connection-name span. A slot rather
   * than threading `connections`/`onSwitch`/status props through TitleBar —
   * The Switcher keeps growing new affordances, and a slot stops TitleBar's
   * prop list growing every time. Falls back to the plain `connectionName`
   * span when omitted.
   */
  connectionSlot?: React.ReactNode;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  shellOpen: boolean;
  shellAvailable: boolean;
  onToggleShell: () => void;
}

export function TitleBar({
  dark,
  toggle,
  connectionName,
  connectionSlot,
  onOpenSettings,
  onOpenPalette,
  shellOpen,
  shellAvailable,
  onToggleShell,
}: TitleBarProps) {
  const T = themeVars;
  const shellTooltip = shellAvailable
    ? 'Toggle Mongo shell pane'
    : 'Open a connection to use the shell';
  return (
    <Group
      gap={10}
      wrap="nowrap"
      style={{
        height: 46,
        padding: '0 14px',
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <div style={{ width: 70, flexShrink: 0 }} />
      <Group
        gap={6}
        wrap="nowrap"
        style={{
          minWidth: 0,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {connectionSlot ?? (
          <span style={{ fontSize: 12, color: T.textMuted }}>
            {connectionName ?? '—'}
          </span>
        )}
      </Group>
      {/* Plain drag spacer, not a no-drag Group — the Connection Switcher
          used to sit in a flex:1 no-drag Group, which made the whole
          middle of the bar (not just the button) undraggable. */}
      <div style={{ flex: 1 }} />
      <Tooltip label={`Search actions (${formatShortcut('⌘K', isMacRenderer())})`} withArrow>
        <Button
          variant="default"
          size="compact-xs"
          onClick={onOpenPalette}
          data-hint-anchor="palette.discover"
          aria-label="Search actions"
          leftSection={I.cmd}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          K
        </Button>
      </Tooltip>
      <Tooltip label={shellTooltip} withArrow>
        <Button
          variant={shellOpen ? 'light' : 'default'}
          color={shellOpen ? 'violet' : 'gray'}
          size="compact-xs"
          onClick={onToggleShell}
          disabled={!shellAvailable}
          aria-pressed={shellOpen}
          leftSection={I.terminal}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          Shell
        </Button>
      </Tooltip>
      <Tooltip label="Settings" withArrow>
        <ActionIcon
          variant="default"
          size="md"
          onClick={onOpenSettings}
          aria-label="Open settings"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {I.gear}
        </ActionIcon>
      </Tooltip>
      <Tooltip label={dark ? 'Switch to light theme' : 'Switch to dark theme'} withArrow>
        <ActionIcon
          variant="default"
          size="md"
          onClick={toggle}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {dark ? I.sun : I.moon}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
