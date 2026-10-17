import React from 'react';
import { ActionIcon, Button, Group, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { api, getErrorMessage } from '../../api/atelier';
import type { ShellOutputEvent } from '@shared/types';
import { useLatest } from '../../commands/useLatest';

const MAX_BUFFER_BYTES = 200_000;

interface Props {
  connectionId: string;
  /** Forwarded so the pane header can show context. */
  connectionName: string | null;
  /** Database the shell opens on (the focused tab's). Read when a session
   *  starts or restarts; a later change does not move a running session.
   *  Omit to use the connection's default database. */
  dbName?: string;
  /** CSS height value. Omit to fill the available space (e.g. when placed
   *  inside a react-resizable-panels Panel). Defaults to '100%'. */
  height?: number | string;
  onClose: () => void;
}

type StartState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; sessionId: string }
  /** The session ended (exit, Stop, the connection went away); a new one needs Restart. */
  | { kind: 'stopped' }
  | { kind: 'error'; message: string };

type ShellAction =
  | { type: 'stopped' }
  | { type: 'starting' }
  | { type: 'ready'; sessionId: string }
  | { type: 'error'; message: string };

function shellReducer(_: StartState, action: ShellAction): StartState {
  switch (action.type) {
    case 'stopped':  return { kind: 'stopped' };
    case 'starting': return { kind: 'starting' };
    case 'ready':    return { kind: 'ready', sessionId: action.sessionId };
    case 'error':    return { kind: 'error', message: action.message };
  }
}

function placeholderFor(kind: StartState['kind'], busy: boolean): string {
  switch (kind) {
    case 'ready':   return busy ? 'running… Ctrl+C to interrupt' : '';
    case 'stopped': return 'shell stopped — press Restart';
    case 'error':   return 'shell unavailable — press Restart';
    case 'idle':
    case 'starting': return 'starting…';
  }
}

/**
 * Bottom pane hosting a JavaScript REPL (run in a runner child) with a Mongo driver
 * context. Streams stdout into a rolling buffer; forwards each entered line
 * to the session's stdin.
 */
export function MongoShellPane({ connectionId, connectionName, dbName, height, onClose }: Props) {
  const T = themeVars;
  const [state, dispatch] = React.useReducer(shellReducer, { kind: 'idle' } satisfies StartState);
  const [buffer, setBuffer] = React.useState('');
  const [input, setInput] = React.useState('');
  // Lines sent whose prompt has not come back: the shell is busy while any is
  // outstanding. A count and not a flag, since input is never paused and a
  // late result can arrive after later lines have already finished.
  const [pending, setPending] = React.useState(0);
  const busy = state.kind === 'ready' && pending > 0;
  // Set by Interrupt so the restart it triggers keeps the scrollback.
  const keepBufferRef = React.useRef(false);
  const outputRef = React.useRef<HTMLPreElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Whether the user was scrolled to (or near) the bottom before the most
  // recent buffer change. Read in the auto-scroll effect below, so new
  // output only pulls the view down when the user hasn't scrolled up to
  // read scrollback. Starts true so the initial render still lands at the
  // bottom.
  const stickToBottomRef = React.useRef(true);
  const STICK_TO_BOTTOM_THRESHOLD_PX = 4;

  // Append output, capping the buffer at MAX_BUFFER_BYTES. Drop-from-front
  // policy so a runaway query never pegs renderer memory — the user can
  // always scroll back through recent output, just not all of it.
  const append = React.useCallback((chunk: string) => {
    setBuffer((prev) => {
      const next = prev + chunk;
      if (next.length <= MAX_BUFFER_BYTES) return next;
      return next.slice(next.length - MAX_BUFFER_BYTES);
    });
  }, []);

  // Subscribe to output events for the duration of the pane's lifetime.
  // Filtering by sessionId happens here so events from a stale session
  // (after restart) don't bleed into the new buffer.
  const sessionIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const unsubscribe = api.mshell.onOutput((evt: ShellOutputEvent) => {
      if (evt.sessionId !== sessionIdRef.current) return;
      if (evt.kind === 'exit') {
        append('\n[shell session ended]\n');
        dispatch({ type: 'stopped' });
        setPending(0);
        sessionIdRef.current = null;
        return;
      }
      if (evt.kind === 'prompt') {
        setPending((n) => Math.max(0, n - 1));
        return;
      }
      if (evt.data) append(evt.data);
    });
    return unsubscribe;
  }, [append]);

  // Auto-scroll to bottom on new output, but only if the user was already
  // pinned to the bottom before this change landed. Otherwise they're
  // reading scrollback and a forced scroll would yank them away from it.
  React.useEffect(() => {
    const el = outputRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [buffer]);

  // Track whether the user is at the bottom as they scroll, so the effect
  // above knows whether to follow new output.
  const handleOutputScroll = (e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  // Auto-start when the pane mounts, the connection changes, or the user
  // clicks Restart (`restartNonce` ticks). The IIFE awaits a microtask
  // before calling setState so this complies with the
  // react-hooks/set-state-in-effect rule (no synchronous setState in an
  // effect body).
  const [restartNonce, setRestartNonce] = React.useState(0);
  // Through a ref, and not an effect dependency: switching the focused tab
  // must not restart the shell and wipe its scrollback. Declared before the
  // effect so Restart sees the latest value.
  const dbNameRef = useLatest(dbName);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      dispatch({ type: 'starting' });
      setPending(0);
      if (!keepBufferRef.current) setBuffer('');
      keepBufferRef.current = false;
      try {
        const info = await api.mshell.start({ connectionId, dbName: dbNameRef.current });
        if (cancelled) {
          void api.mshell.stop({ sessionId: info.sessionId }).catch(() => {});
          return;
        }
        sessionIdRef.current = info.sessionId;
        dispatch({ type: 'ready', sessionId: info.sessionId });
        queueMicrotask(() => inputRef.current?.focus());
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: 'error',
          message: getErrorMessage(err, 'failed to start shell'),
        });
      }
    })();
    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id) void api.mshell.stop({ sessionId: id }).catch(() => {});
    };
  }, [connectionId, restartNonce, dbNameRef]);

  // Up/Down arrow command history. Capped to prevent unbounded growth on
  // long sessions; consecutive duplicates collapse so a repeat-Enter user
  // doesn't pollute the buffer. `historyIndex === null` means "live edit"
  // (user typing fresh); a non-null index points at the slot they're
  // currently navigating.
  const HISTORY_LIMIT = 200;
  const historyRef = React.useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
  // Captures the user's in-progress edit when they Up-arrow into history
  // so the original text is restored if they Down-arrow back past the
  // newest entry. Without this, the buffer would always reset to empty.
  const liveBufferRef = React.useRef('');

  const submitLine = () => {
    if (state.kind !== 'ready') return;
    // Trim before checking and dispatching: whitespace-only commands
    // shouldn't pollute history or get sent to the REPL as no-ops.
    const line = input.trim();
    if (line.length > 0) {
      const hist = historyRef.current;
      if (hist[hist.length - 1] !== line) {
        hist.push(line);
        if (hist.length > HISTORY_LIMIT) hist.shift();
      }
    }
    setHistoryIndex(null);
    liveBufferRef.current = '';
    setInput('');
    if (line.length === 0) return;
    // Submitting a command re-pins to the bottom even if the user had
    // scrolled up to read scrollback — like a real terminal, entering
    // input should always surface the command's echo and its output.
    stickToBottomRef.current = true;
    // The REPL doesn't echo stdin — paint what the user typed locally so
    // they see their own command in the transcript.
    append(`> ${line}\n`);
    setPending((n) => n + 1);
    // A refused write (read-only switch, session gone) never gets a prompt back,
    // so it is taken off the busy count here and its reason printed.
    void api.mshell.write({ sessionId: state.sessionId, data: line + '\n' }).catch((err: unknown) => {
      setPending((n) => Math.max(0, n - 1));
      append(`[could not send the command: ${getErrorMessage(err, 'write failed')}]\n`);
    });
  };

  const navigateHistory = (direction: 'up' | 'down') => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (direction === 'up') {
      // Stash the live buffer on first step into history so Down past
      // newest can restore it.
      if (historyIndex === null) liveBufferRef.current = input;
      const next = historyIndex === null ? hist.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(hist[next] ?? '');
    } else {
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= hist.length) {
        // Stepped past the newest entry — return to the live edit buffer.
        setHistoryIndex(null);
        setInput(liveBufferRef.current);
      } else {
        setHistoryIndex(next);
        setInput(hist[next] ?? '');
      }
    }
  };

  const handleStop = async () => {
    const id = sessionIdRef.current;
    if (id) await api.mshell.stop({ sessionId: id }).catch(() => {});
  };

  // The call being waited on cannot be cancelled inside the session, so
  // interrupting ends the session and starts another, as Restart does but
  // keeping what was printed so far. Variables defined in the old one are gone.
  const handleInterrupt = async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Forget the old session first: its goodbye must not read as the new one ending.
    sessionIdRef.current = null;
    dispatch({ type: 'starting' });
    setPending(0);
    try {
      await api.mshell.stop({ sessionId: id });
    } catch (err) {
      append(`\n[could not interrupt the shell: ${getErrorMessage(err, 'stop failed')}]\n`);
      dispatch({ type: 'stopped' });
      return;
    }
    append('\n[interrupted — the running call was cancelled; shell restarted, variables were lost]\n');
    keepBufferRef.current = true;
    setRestartNonce((n) => n + 1);
  };

  const handleRestart = () => {
    setRestartNonce((n) => n + 1);
  };

  return (
    <div
      data-testid="mongo-shell-pane"
      style={{
        height: height ?? '100%',
        display: 'flex',
        flexDirection: 'column',
        borderTop: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <Group
        gap={8}
        wrap="nowrap"
        style={{
          padding: '4px 10px',
          borderBottom: `1px solid ${T.border}`,
          fontSize: 11,
          color: T.textMuted,
          flexShrink: 0,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {I.terminal}
          <span style={{ fontWeight: 600, color: T.text }}>mongosh</span>
        </span>
        {connectionName && <span>· {connectionName}</span>}
        <span style={{ flex: 1 }} />
        {busy && (
          <>
            <span role="status" data-testid="mongo-shell-busy">running…</span>
            <Button variant="default" size="compact-xs" onClick={() => void handleInterrupt()}>
              Interrupt
            </Button>
          </>
        )}
        <Tooltip label="Restart shell" withArrow>
          <Button
            variant="default"
            size="compact-xs"
            onClick={handleRestart}
            disabled={state.kind === 'starting'}
          >
            Restart
          </Button>
        </Tooltip>
        <Tooltip label="Stop shell" withArrow>
          <Button
            variant="default"
            size="compact-xs"
            onClick={() => void handleStop()}
            disabled={state.kind !== 'ready'}
          >
            Stop
          </Button>
        </Tooltip>
        <Tooltip label="Close" withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            onClick={onClose}
            aria-label="Close shell pane"
          >
            {I.close}
          </ActionIcon>
        </Tooltip>
      </Group>

      <pre
        ref={outputRef}
        onScroll={handleOutputScroll}
        data-testid="mongo-shell-output"
        style={{
          flex: 1,
          margin: 0,
          padding: '8px 10px',
          overflowY: 'auto',
          background: T.bg,
          color: T.text,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {state.kind === 'starting' && '[starting shell…]\n'}
        {state.kind === 'error' && `[error] ${state.message}\n`}
        {buffer}
      </pre>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 10px',
          borderTop: `1px solid ${T.border}`,
          background: T.surfaceRaised,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: T.textMuted,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            marginRight: 6,
          }}
        >
          ›
        </span>
        <input
          ref={inputRef}
          aria-label="Mongo shell input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Any manual edit drops us out of history navigation back to
            // the live buffer.
            if (historyIndex !== null) setHistoryIndex(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitLine();
            } else if (
              e.key === 'c' &&
              e.ctrlKey &&
              busy &&
              // Selected text means copy, as in any text field.
              e.currentTarget.selectionStart === e.currentTarget.selectionEnd
            ) {
              e.preventDefault();
              void handleInterrupt();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              navigateHistory('up');
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              navigateHistory('down');
            }
          }}
          disabled={state.kind !== 'ready'}
          placeholder={placeholderFor(state.kind, busy)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: T.text,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
          }}
        />
      </div>
    </div>
  );
}

