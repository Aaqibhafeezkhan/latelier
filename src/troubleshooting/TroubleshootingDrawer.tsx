import React from 'react';
import { Button, Drawer, Group, Paper, Stack, Text } from '@mantine/core';
import { api } from '../api/atelier';
import { notify } from '../theme/notifications';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import { SubmitButton } from '../components/SubmitButton';
import { InlineMarkdown } from './markdown';
import { ACTION_LABEL, pickRecipe } from './recipes';
import { docUrlFor } from './repoUrl';
import type {
  RecipeActionHandlers,
  RecipeMatchInput,
  SuggestedActionId,
} from './types';

const DRAWER_TITLE_ID = 'troubleshooting-drawer-title';

export function TroubleshootingDrawer({
  input,
  actions,
  onClose,
}: {
  input: RecipeMatchInput;
  actions?: RecipeActionHandlers;
  onClose: () => void;
}) {
  const recipe = pickRecipe(input);
  const [pendingAction, setPendingAction] = React.useState<SuggestedActionId | null>(null);
  // replaces the `previousFocus` capture/restore `TroubleshootingProvider`
  // used to carry. Both close paths go through it, the succeeded-action one
  // included: a recipe action retries the connection in place, it does not open
  // another surface, so the trigger the user came from is still there.
  const close = useDialogFocusReturn(onClose);

  const runAction = React.useCallback(
    async (id: SuggestedActionId) => {
      const handler = actions?.[id];
      if (!handler || pendingAction !== null) return;
      setPendingAction(id);
      let succeeded: boolean;
      try {
        succeeded = await handler();
      } catch {
        // Trigger site is responsible for surfacing its own error UI;
        // the drawer just stays open.
        succeeded = false;
      } finally {
        setPendingAction(null);
      }
      if (succeeded) close();
    },
    [actions, close, pendingAction],
  );

  const docHref = docUrlFor(recipe.docAnchor);

  return (
    <Drawer
      opened
      onClose={close}
      position="right"
      size={480}
      withCloseButton
      closeButtonProps={{ 'aria-label': 'Close troubleshooting drawer' }}
      padding={0}
      title={
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }}>
          Connection troubleshooting
        </Text>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' },
        header: { padding: '12px 16px' },
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Stack gap="xs">
          <Text id={DRAWER_TITLE_ID} size="md" fw={600}>
            {recipe.title}
          </Text>
          <Text size="sm" c="dimmed" lh={1.55}>
            <InlineMarkdown source={recipe.diagnosis} />
          </Text>
        </Stack>

        <Stack gap="xs">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }}>
            Try these in order
          </Text>
          <Stack gap="sm" component="ol" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {recipe.steps.map((step, i) => (
              <Paper key={i} withBorder p="sm" radius="md" component="li">
                <Group gap="xs" align="baseline" mb="xs">
                  <Text c="dimmed" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 14 }}>
                    {i + 1}.
                  </Text>
                  <Text size="sm" fw={600}>
                    {step.title}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" lh={1.55} style={{ paddingLeft: 22 }}>
                  <InlineMarkdown source={step.body} />
                </Text>
                {step.suggestedAction && actions?.[step.suggestedAction] && (
                  <Group justify="flex-end" mt="sm">
                    <SubmitButton
                      size="compact-xs"
                      variant="filled"
                      onClick={() => void runAction(step.suggestedAction!)}
                      // Only the activated step's button fakes disabled —
                      // its siblings get the real attribute, since they were
                      // never focused and so can't be blurred to `<body>`.
                      disabled={pendingAction !== null && pendingAction !== step.suggestedAction}
                      submitting={pendingAction === step.suggestedAction}
                    >
                      {pendingAction === step.suggestedAction
                        ? 'Retrying…'
                        : ACTION_LABEL[step.suggestedAction]}
                    </SubmitButton>
                  </Group>
                )}
              </Paper>
            ))}
          </Stack>
        </Stack>
      </div>

      <Group
        justify="space-between"
        align="center"
        p="sm"
        gap="xs"
        style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
      >
        <Text size="xs" c="dimmed">
          Still stuck?
        </Text>
        <Button
          variant="default"
          size="compact-xs"
          onClick={() => {
            void api.app.openExternal(docHref).catch(() => {
              notify.error('Could not open the link');
            });
          }}
        >
          Open the full guide ↗
        </Button>
      </Group>
    </Drawer>
  );
}
