import { Kbd, Modal, Stack, Text } from '@mantine/core';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import { isMacRenderer } from '../utils/platform';
import { formatShortcut } from './shortcutLabel';
import { STATIC_SHORTCUTS } from './staticShortcuts';
import { useRegistrySnapshot } from './useRegistrySnapshot';
import { GROUP_LABEL, GROUP_ORDER } from './types';

interface Row {
  id: string;
  title: string;
  keys: string;
}

/** Every registered command that has a shortcut, plus the ones that are not commands. */
export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const close = useDialogFocusReturn(onClose);
  const commands = useRegistrySnapshot();
  const mac = isMacRenderer();

  const sections: Array<{ label: string; rows: Row[] }> = GROUP_ORDER.map((group) => ({
    label: GROUP_LABEL[group],
    rows: commands
      .filter((c) => c.group === group && c.shortcut)
      .map((c) => ({ id: c.id, title: c.title, keys: c.shortcut! }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  }));
  for (const s of STATIC_SHORTCUTS) {
    sections.push({
      label: s.section,
      rows: s.items.map((i) => ({ id: `${s.section}:${i.keys}`, title: i.title, keys: i.keys })),
    });
  }

  return (
    <Modal opened onClose={close} title="Keyboard shortcuts" centered size="md">
      <Stack gap="md">
        {sections
          .filter((s) => s.rows.length > 0)
          .map((s) => (
            <section key={s.label} aria-label={s.label}>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
                {s.label}
              </Text>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {s.rows.map((r) => (
                  <li
                    key={r.id}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}
                  >
                    <Text size="sm">{r.title}</Text>
                    <Kbd>{formatShortcut(r.keys, mac)}</Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </Stack>
    </Modal>
  );
}
