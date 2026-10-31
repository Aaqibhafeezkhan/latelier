import React from 'react';
import { Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { clearActivity, getActivity, subscribeActivity } from '../theme/activityLog';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';

interface ActivityLogModalProps {
  onClose: () => void;
}

const LEVEL_LABEL = { error: 'Error', warning: 'Warning' } as const;

/**
 * This session's error and warning toasts, newest first, kept after each toast
 * has closed. Nothing survives a restart.
 */
export function ActivityLogModal({ onClose }: ActivityLogModalProps) {
  const close = useDialogFocusReturn(onClose);
  const entries = React.useSyncExternalStore(subscribeActivity, getActivity);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  // Clear disables itself, which would drop focus to <body>; Close is the
  // control left to use.
  const clear = () => {
    clearActivity();
    closeRef.current?.focus();
  };

  return (
    <Modal opened onClose={close} title="Activity log" centered size="xl">
      <Stack gap="md">
        {entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No errors or warnings in this session.
          </Text>
        ) : (
          <Table striped aria-label="Errors and warnings">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Level</Table.Th>
                <Table.Th>Title</Table.Th>
                <Table.Th>Message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{new Date(e.at).toLocaleTimeString()}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c={e.level === 'error' ? 'red' : 'orange'}>
                      {LEVEL_LABEL[e.level]}
                    </Text>
                  </Table.Td>
                  <Table.Td>{e.title ?? ''}</Table.Td>
                  <Table.Td style={{ wordBreak: 'break-word' }}>{e.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" size="compact-xs" onClick={clear} disabled={entries.length === 0}>
            Clear
          </Button>
          <Button ref={closeRef} variant="subtle" size="compact-xs" onClick={close}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
