import React from 'react';
import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { api, getErrorMessage } from '../api/atelier';

interface ErrorBoundaryState {
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

/**
 * Top-level render-error catch-all (T3.1). Wraps <Routes> in App.tsx so an
 * uncaught render error anywhere in the route tree shows a recoverable
 * fallback instead of a blank white screen.
 *
 * Class component is required here — componentDidCatch / getDerivedStateFromError
 * have no hook equivalent in React.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Renderer convention is bare console.error (see CommandPalette.tsx,
    // rank.ts) — electron/log.ts is main-process only and must not be
    // imported here. This is the load-bearing "never silently swallow" log.
    console.error('[ErrorBoundary] uncaught render error', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (error) {
      return <ErrorBoundaryFallback onReload={this.handleReload} />;
    }
    return this.props.children;
  }
}

function ErrorBoundaryFallback({ onReload }: { onReload: () => void }) {
  const [reporting, setReporting] = React.useState(false);
  const [reportMessage, setReportMessage] = React.useState<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  // The fallback replaces the whole screen, so keyboard and screen-reader
  // focus would otherwise be left on an unmounted node.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const handleReport = async () => {
    setReporting(true);
    try {
      const { path } = await api.app.diagnosticBundle();
      setReportMessage(path ? `Saved to ${path}` : "Couldn't generate a diagnostic bundle.");
    } catch (err) {
      setReportMessage(getErrorMessage(err, "Couldn't generate a diagnostic bundle."));
    } finally {
      setReporting(false);
    }
  };

  return (
    <Stack
      align="center"
      justify="center"
      gap="md"
      p="xl"
      role="alert"
      style={{ minHeight: '100vh' }}
    >
      <Title order={3} ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>
        Something went wrong
      </Title>
      <Text size="sm" c="dimmed" ta="center" maw={480}>
        Atelier hit an unexpected error and couldn't continue rendering this screen. You can
        reload the app, or export a diagnostic bundle to share with support. Details were logged
        to the console.
      </Text>
      <Group>
        <Button variant="default" onClick={onReload}>
          Reload
        </Button>
        <Button variant="filled" onClick={handleReport} disabled={reporting}>
          {reporting ? 'Reporting…' : 'Report'}
        </Button>
      </Group>
      {reportMessage && (
        <Text size="xs" c="dimmed">
          {reportMessage}
        </Text>
      )}
    </Stack>
  );
}
