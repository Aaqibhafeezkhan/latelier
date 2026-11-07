import React from 'react';
import { Modal } from '@mantine/core';
import { fixedModalStyles } from '../../components/fixedModal';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { confirmDestructive } from '../../utils/confirm';
import { ConnectionForm } from './ConnectionForm';
import { reportConnectionFormDirty } from './reportUnsavedForm';

export interface ConnectionFormModalProps {
  connectionId?: string;
  onSaved: (id: string) => void;
  onClose: () => void;
  // Where to send focus on dismiss, when the opener's own trigger element may already be detached.
  returnFocusTo?: HTMLElement | null;
  /** Open on the Auth tab with the password field focused (#396). */
  initialFocus?: 'password';
}

export function ConnectionFormModal({
  connectionId,
  onSaved,
  onClose,
  returnFocusTo,
  initialFocus,
}: ConnectionFormModalProps) {
  const close = useDialogFocusReturn(onClose, returnFocusTo);
  const [dirty, setDirty] = React.useState(false);
  // Stable identity: the form calls this from an effect keyed on it.
  const onDirtyChange = React.useCallback((next: boolean) => {
    setDirty(next);
    reportConnectionFormDirty(next);
  }, []);
  React.useEffect(() => () => reportConnectionFormDirty(false), []);

  const requestClose = async () => {
    if (!dirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the connection form and loses what you typed, including any password.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const sharedFormProps = {
    onSaved: (id: string) => {
      reportConnectionFormDirty(false);
      onSaved(id);
    },
    onCancel: () => void requestClose(),
    onDirtyChange,
    embedded: true,
    initialFocus,
  };

  return (
    <Modal
      opened
      onClose={() => void requestClose()}
      title={connectionId ? 'Edit Connection' : 'New Connection'}
      size="xl"
      centered
      closeOnClickOutside={false}
      // The tallest tab (General) sets the height, so Save stays where it is
      // across tabs; shorter tabs leave empty space rather than shrinking it.
      styles={fixedModalStyles(654)}
    >
      {connectionId
        ? <ConnectionForm mode="edit" connectionId={connectionId} {...sharedFormProps} />
        : <ConnectionForm mode="create" {...sharedFormProps} />}
    </Modal>
  );
}
