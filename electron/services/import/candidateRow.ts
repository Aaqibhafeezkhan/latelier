import type { ConnectionInput, RepickFile } from '@shared/types';
import type { SecretValues } from '../connectionExportFormat.ts';

/** One importable connection, whatever file it came from. Main process only. */
export interface CandidateRow {
  /** No secrets (password/sshPassword/sshPassphrase excluded). */
  input: Partial<ConnectionInput>;
  /** Plaintext, main only. */
  secrets: SecretValues;
  /** Opaque to the service; decrypted at commit. */
  sealed?: { kind: 'latelier' | 'compass' };
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
