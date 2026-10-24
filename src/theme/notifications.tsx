import { notifications } from '@mantine/notifications';
import { Button, Group, Text } from '@mantine/core';
import { recordActivity, type ActivityEntry } from './activityLog';

// Project-conventions wrapper around Mantine notifications. Callers stay
// explicit (per X12 resolved decision: no global auto-toast on IPC failures).
// Defaults: 4s auto-dismiss for info/success/warning, 6s for errors so the
// user has time to read details before they vanish.

interface NotifyAction {
  label: string;
  onClick: () => void;
}

interface NotifyOptions {
  title?: string;
  /** Auto-dismiss in ms. `false` keeps the toast open until dismissed. */
  autoClose?: number | false;
  /** Reuses/replaces a prior toast with the same id instead of stacking a new one. */
  id?: string;
  /**
   * One action button rendered in the toast, e.g. "Undo" on a destructive
   * edit that only needs local-editor-state friction (docs/adr/0013). Fires
   * once: clicking it runs `onClick` and dismisses the toast.
   */
  action?: NotifyAction;
}

function show(
  color: string,
  defaultTitle: string | undefined,
  defaultAutoClose: number,
  message: string,
  options: NotifyOptions,
) {
  let id = options.id;
  const action = options.action;
  const messageNode = action ? (
    <Group gap="sm" wrap="nowrap" justify="space-between">
      <Text size="sm">{message}</Text>
      <Button
        size="compact-xs"
        variant="subtle"
        onClick={() => {
          action.onClick();
          if (id) notifications.hide(id);
        }}
      >
        {action.label}
      </Button>
    </Group>
  ) : (
    message
  );
  // An action toast needs longer than the plain-message default to actually
  // be clicked, not just read, unless the caller asked for something else.
  const autoClose = options.autoClose ?? (options.action ? 8000 : defaultAutoClose);
  // `notifications.show` silently no-ops when `id` already names a live
  // toast (mantine's own dedup guard against a duplicate `id`) — reusing an
  // id to *replace* a toast's content (a fresh action closure, in
  // particular) needs the old one hidden first, so this `show` reads as
  // "there is now exactly one toast with this id" rather than "add".
  if (id) notifications.hide(id);
  id = notifications.show({
    id,
    color,
    title: options.title ?? defaultTitle,
    message: messageNode,
    autoClose,
  });
  return id;
}

// Errors and warnings also go to the activity log, which outlives the toast.
function record(level: ActivityEntry['level'], message: string, options: NotifyOptions): void {
  recordActivity({ id: crypto.randomUUID(), level, title: options.title, message, at: new Date().toISOString() });
}

export const notify = {
  error(message: string, options: NotifyOptions = {}) {
    record('error', message, options);
    return show('red', 'Error', 6000, message, options);
  },
  success(message: string, options: NotifyOptions = {}) {
    return show('green', undefined, 4000, message, options);
  },
  info(message: string, options: NotifyOptions = {}) {
    return show('blue', undefined, 4000, message, options);
  },
  warning(message: string, options: NotifyOptions = {}) {
    record('warning', message, options);
    return show('orange', 'Warning', 4000, message, options);
  },
};
