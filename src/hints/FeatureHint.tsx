import React from 'react';
import {
  ActionIcon,
  Button,
  FocusTrap,
  Group,
  Paper,
  Portal,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { I } from '../icons';
import { HINT_REGISTRY } from './registry';
import type { FeatureHintId } from '@shared/types';

const POPOVER_WIDTH = 280;

interface FeatureHintProps {
  id: FeatureHintId;
  visible: boolean;
  onDismiss: () => void;
  onCta?: () => void;
  /** Override the default `[data-hint-anchor="<id>"]` lookup. */
  anchorSelector?: string;
}

// A hint appears while the user is typing, so it never takes focus on its own:
// it is announced through a polite live region instead. F6 is the deliberate
// way in; focus is then trapped inside until the hint is dismissed, and goes
// back to where it was.
//
// Discovers an anchor element via [data-hint-anchor="<id>"] (or override),
// then renders a positioned Paper popover centered below it. Mantine handles
// theming + dark mode via CSS variables; positioning stays manual because
// the anchor isn't a React child of the hint — it's an arbitrary DOM element
// elsewhere in the tree.
export function FeatureHint({
  id,
  visible,
  onDismiss,
  onCta,
  anchorSelector,
}: FeatureHintProps) {
  const copy = HINT_REGISTRY[id];
  const selector = anchorSelector ?? `[data-hint-anchor="${id}"]`;
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    const update = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = r.bottom + 8;
      const left = Math.max(
        8,
        Math.min(
          window.innerWidth - POPOVER_WIDTH - 8,
          r.left + r.width / 2 - POPOVER_WIDTH / 2,
        ),
      );
      setPos({ top, left });
    };
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf);
      // A hint that hides and comes back must not flash at the old spot.
      setPos(null);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [visible, selector]);

  const shown = visible && pos !== null;

  return (
    <>
      {/* Always mounted: a live region is only spoken when its text changes, not
          when the region itself appears. No role="status": every hint call site
          mounts one, and screen-reader queries for the page's real status
          regions (the builder's "N not applied" banner) must stay unambiguous. */}
      <Portal>
        <VisuallyHidden aria-live="polite">
          {shown ? copy.title : ''}
        </VisuallyHidden>
      </Portal>
      {shown && <HintPopover id={id} pos={pos} onDismiss={onDismiss} onCta={onCta} />}
    </>
  );
}

// Mounted only while the hint shows, so the focus trap, the remembered focus
// spot and the F6 listener all start fresh every time it comes back.
function HintPopover({
  id,
  pos,
  onDismiss,
  onCta,
}: {
  id: FeatureHintId;
  pos: { top: number; left: number };
  onDismiss: () => void;
  onCta?: () => void;
}) {
  const copy = HINT_REGISTRY[id];
  const paperRef = React.useRef<HTMLDivElement | null>(null);
  const gotItRef = React.useRef<HTMLButtonElement | null>(null);
  // Where focus was when F6 pulled it into the hint; null when it got there another way.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);
  const bodyId = React.useId();

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F6') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const active = document.activeElement;
      e.preventDefault();
      if (paperRef.current?.contains(active)) return;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      gotItRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Dismiss, handing focus back to where F6 found it. The blur handler forgets that
  // spot once focus leaves the hint, so a hint focus never reached restores nothing.
  const leave = () => {
    const back = returnFocusRef.current;
    onDismiss();
    if (back?.isConnected) back.focus();
  };

  return (
    <Portal>
      <FocusTrap active={focusInside} innerRef={paperRef}>
        <Paper
        role="dialog"
        aria-modal="false"
        aria-label={copy.title}
        aria-describedby={bodyId}
        onFocus={() => setFocusInside(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setFocusInside(false);
            returnFocusRef.current = null;
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          leave();
        }}
        data-feature-hint={id}
        shadow="lg"
        withBorder
        radius="md"
        style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          width: POPOVER_WIDTH,
          zIndex: 1200,
          padding: '12px 14px',
        }}
      >
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <Stack gap={4} style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              {copy.title}
            </Text>
            <Text id={bodyId} size="xs" c="dimmed" lh={1.45}>
              {copy.body}
            </Text>
          </Stack>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={leave}
            aria-label="Dismiss hint"
          >
            {I.close}
          </ActionIcon>
        </Group>
        <Group gap="xs" justify="flex-end" mt="xs">
          {copy.ctaLabel && onCta && (
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => {
                onCta();
                leave();
              }}
            >
              {copy.ctaLabel}
            </Button>
          )}
          <Button ref={gotItRef} data-autofocus size="compact-xs" variant="subtle" onClick={leave}>
            Got it
          </Button>
        </Group>
        </Paper>
      </FocusTrap>
    </Portal>
  );
}
