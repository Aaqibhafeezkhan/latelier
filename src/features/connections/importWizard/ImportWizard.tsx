import React from 'react';
import { Alert, Button, Group, Modal, Stack } from '@mantine/core';
import type {
  ImportCommitInput,
  ImportCommitResult,
  ImportSource,
  MapTarget,
  MappingCollection,
  Review,
} from '@shared/types';
import { api, getErrorMessage, isIpcError } from '../../../api/atelier';
import { notifyConnectionsChanged } from '../../../state/connections';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import { SourceStep } from './SourceStep';
import { MappingStep } from './MappingStep';
import { ReviewStep } from './ReviewStep';
import { ResultStep } from './ResultStep';

type Step = 'source' | 'mapping' | 'review' | 'result';

export interface ImportWizardProps {
  /** Which half of the Source step the entry point opens on. */
  initial: 'file' | 'paste';
  onClose(): void;
}

/**
 * C14 §1: Source → [Field Mapping, Unknown JSON only] → Final approval →
 * Result. Main holds the parsed input behind `token`; this shell owns every
 * `api.conn.import*` call and the steps stay presentational.
 */
export function ImportWizard({ initial, onClose }: ImportWizardProps) {
  const close = useDialogFocusReturn(onClose);
  const [step, setStep] = React.useState<Step>('source');
  const [token, setToken] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<ImportSource | null>(null);
  const [collections, setCollections] = React.useState<MappingCollection[] | null>(null);
  const [ambiguousCollections, setAmbiguousCollections] = React.useState<number | undefined>();
  const [review, setReview] = React.useState<Review | null>(null);
  // Bumped on every new review so the approval step's ticks and fields never
  // carry over to rows they were not chosen for; `importMap` keeps the token.
  const [reviewKey, setReviewKey] = React.useState(0);
  const [result, setResult] = React.useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [passphraseError, setPassphraseError] = React.useState<string | undefined>();

  const run = async (fallback: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setPassphraseError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(getErrorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const currentToken = () => {
    if (token === null) throw new Error('ImportWizard: no import token for this step');
    return token;
  };

  const showReview = (src: ImportSource, tok: string, r: Review) => {
    if (src !== 'unknown') setCollections(null);
    setSource(src);
    setToken(tok);
    setReview(r);
    setReviewKey((k) => k + 1);
    setStep('review');
  };

  const pickFile = () =>
    run('Could not read the file', async () => {
      const res = await api.conn.importOpen();
      if ('cancelled' in res) return;
      if (res.source === 'unknown') {
        setSource('unknown');
        setToken(res.token);
        setCollections(res.collections);
        setAmbiguousCollections(res.ambiguousCollections);
        setStep('mapping');
      } else {
        showReview(res.source, res.token, res.review);
      }
    });

  const pasteUris = (uris: string[]) =>
    run('Could not read the connection strings', async () => {
      const res = await api.conn.importUris(uris);
      showReview('uris', res.token, res.review);
    });

  const applyMapping = (at: string, mapping: Partial<Record<MapTarget, string>>) =>
    run('Could not apply the mapping', async () => {
      const tok = currentToken();
      const res = await api.conn.importMap({ token: tok, at, mapping });
      showReview('unknown', tok, res.review);
    });

  const commit = async (input: Omit<ImportCommitInput, 'token'>) => {
    setBusy(true);
    setError(undefined);
    setPassphraseError(undefined);
    try {
      const res = await api.conn.importCommit({ ...input, token: currentToken() });
      setResult(res);
      setStep('result');
      notifyConnectionsChanged();
    } catch (e) {
      // A wrong passphrase leaves the token usable in main, so the review stays for a retry.
      // Main words this per source (own export vs Compass), so show its message verbatim.
      if (isIpcError(e) && e.code === 'BAD_PASSPHRASE') setPassphraseError(e.message);
      else {
        setError(getErrorMessage(e, 'Import failed'));
        // Rows may have been created before the failure; the list must not stay stale.
        notifyConnectionsChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = (
    <Group justify="flex-start">
      <Button variant="subtle" size="compact-xs" onClick={close} disabled={busy}>
        Cancel
      </Button>
    </Group>
  );

  return (
    <Modal
      opened
      onClose={busy ? () => {} : close}
      title="Import Connections"
      centered
      size="xl"
      // The wizard can sit over interactive surfaces (the Connections table);
      // its dismiss gestures are its own and must not reach their handlers.
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation();
      }}
      overlayProps={{ onClick: (e) => e.stopPropagation() }}
    >
      <Stack gap="sm">
        {step === 'source' && (
          <>
            <SourceStep initial={initial} busy={busy} error={error} onFile={() => void pickFile()} onUris={(u) => void pasteUris(u)} />
            {cancel}
          </>
        )}
        {/* Kept mounted (hidden) under the review so Back finds the user's choices intact. */}
        {collections && token && (step === 'mapping' || step === 'review') && (
          <div style={step === 'mapping' ? undefined : { display: 'none' }}>
            <Stack gap="sm">
              <MappingStep
                key={token}
                collections={collections}
                ambiguousCollections={ambiguousCollections}
                busy={busy}
                onBack={() => {
                  setError(undefined);
                  setStep('source');
                }}
                onNext={(at, mapping) => void applyMapping(at, mapping)}
              />
              {step === 'mapping' && error && (
                <Alert color="red" variant="light" role="alert">
                  {error}
                </Alert>
              )}
              {cancel}
            </Stack>
          </div>
        )}
        {step === 'review' && review && source && (
          <ReviewStep
            key={reviewKey}
            source={source}
            review={review}
            busy={busy}
            error={error}
            passphraseError={passphraseError}
            onBack={
              source === 'unknown'
                ? () => {
                    setError(undefined);
                    setStep('mapping');
                  }
                : undefined
            }
            onCancel={close}
            onCommit={(input) => void commit(input)}
          />
        )}
        {step === 'result' && result && (
          <>
            <ResultStep result={result} />
            <Group justify="flex-end">
              <Button size="compact-xs" onClick={close} autoFocus>
                Done
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
