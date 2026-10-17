import { z } from 'zod';
import type { ConnectionInput, RepickFile } from '@shared/types';
import { ValidationError } from '../../errors.ts';
import { HexColor } from '../../ipc/validators.ts';
import { parseLine } from '../connectionBulkAdd.ts';
import type { SecretValues } from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';

/*
 * A MongoDB Compass "Export Connections" file (C14 §4), already read with
 * `EJSON.parse` so its `$numberInt` values are plain numbers. Shape pinned by
 * the real exports in tests/fixtures/compass; keys this reader doesn't use pass
 * through untouched.
 */
const SshTunnel = z.looseObject({
  host: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  identityKeyFile: z.string().optional(),
  identityKeyPassphrase: z.string().optional(),
});

const Entry = z.looseObject({
  favorite: z.looseObject({ name: z.string().optional(), color: z.string().optional() }).optional(),
  connectionOptions: z
    .looseObject({
      connectionString: z.string().optional(),
      sshTunnel: SshTunnel.optional(),
      fleOptions: z.looseObject({ autoEncryption: z.record(z.string(), z.unknown()).optional() }).optional(),
      useApplicationLevelProxy: z.boolean().optional(),
    })
    .optional(),
  savedConnectionType: z.string().optional(),
  connectionSecrets: z.string().optional(),
});

const ExportFile = z.looseObject({ connections: z.array(Entry) });

type CompassEntry = z.infer<typeof Entry>;

export function isCompassExport(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'Compass Connections';
}

/** One candidate row per Compass connection, unusable ones included. */
export function readCompass(value: unknown): CandidateRow[] {
  if ((value as { version?: unknown } | null)?.version !== 1) {
    throw new ValidationError("This Compass export version isn't supported.");
  }
  const file = ExportFile.safeParse(value);
  if (!file.success) throw new ValidationError("This Compass export can't be read.");
  return file.data.connections.map(toRow);
}

function toRow(entry: CompassEntry): CandidateRow {
  const nameHint = entry.favorite?.name ?? '';
  const options = entry.connectionOptions;
  const uri = options?.connectionString;
  const line = uri ? parseLine(uri) : { ok: false as const, reason: 'No connection string.' };
  if (!line.ok) {
    return {
      input: {},
      secrets: {},
      nameHint,
      explicitDirect: false,
      multiHost: false,
      warnings: [],
      repick: [],
      defaultTicked: false,
      unusable: line.reason,
    };
  }

  const { password, ...input }: Partial<ConnectionInput> = line.input;
  const secrets: SecretValues = {};
  if (password) secrets.password = password;
  const repick: RepickFile[] = [...line.repick];
  const warnings = [...line.warnings];

  const color = entry.favorite?.color;
  if (HexColor.safeParse(color).success) input.color = color;

  const tunnel = options!.sshTunnel;
  if (tunnel) {
    // A tunnel without a key file is Compass's password tab, whether the
    // password is inline, sealed in the blob, or left blank.
    const keyAuth = tunnel.identityKeyFile !== undefined;
    input.ssh = {
      enabled: true,
      host: tunnel.host,
      port: tunnel.port,
      username: tunnel.username,
      authMethod: keyAuth ? 'key' : 'password',
    };
    if (tunnel.password) secrets.sshPassword = tunnel.password;
    if (tunnel.identityKeyPassphrase) secrets.sshPassphrase = tunnel.identityKeyPassphrase;
    // The key file's path is never imported: the user picks the file again.
    if (keyAuth) repick.push('sshKey');
  }

  if (Object.keys(options!.fleOptions?.autoEncryption ?? {}).length > 0) {
    warnings.push('In-use encryption (FLE) settings were not imported.');
  }
  if (options!.useApplicationLevelProxy) warnings.push('Application-level proxy settings were not imported.');

  return {
    input,
    secrets,
    ...(entry.connectionSecrets === undefined ? {} : { sealed: { kind: 'compass' as const, blob: entry.connectionSecrets } }),
    nameHint,
    explicitDirect: line.explicitDirect,
    multiHost: line.multiHost,
    warnings,
    repick,
    defaultTicked: entry.savedConnectionType === undefined ? entry.favorite !== undefined : entry.savedConnectionType === 'favorite',
  };
}
