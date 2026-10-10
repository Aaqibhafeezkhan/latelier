import type { ConnectionInput, ExportSecretField, RepickFile } from '@shared/types';
import type { SecretValues } from '../connectionExportFormat.ts';

/**
 * Secrets that stay encrypted until commit. A L'Atelier export names its sealed
 * fields in clear; a Compass blob is opaque until the passphrase opens it.
 */
export type SealedSecrets =
  | { kind: 'latelier'; fields: ExportSecretField[] }
  | { kind: 'compass'; blob: string };

/** One importable connection, whatever file it came from. Main process only. */
export interface CandidateRow {
  /** No secrets (password/sshPassword/sshPassphrase excluded). */
  input: Partial<ConnectionInput>;
  /** Plaintext, main only. */
  secrets: SecretValues;
  sealed?: SealedSecrets;
  /** Raw name before cut/dedupe; '' derives from the host. */
  nameHint: string;
  explicitDirect: boolean;
  /** Carries MULTI_HOST_TRUNCATED. */
  multiHost: boolean;
  warnings: string[];
  repick: RepickFile[];
  defaultTicked: boolean;
  /** Reason the row cannot be ticked. */
  unusable?: string;
}
