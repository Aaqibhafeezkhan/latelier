import { randomUUID } from 'node:crypto';
import type {
  ImportCommitInput,
  ImportCommitResult,
  ImportMapInput,
  ImportMapResult,
  ImportOpenResult,
  ImportSource,
  ImportUrisResult,
  Review,
} from '@shared/types';
import { AppError, ValidationError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { ConnectionService } from '../mongo/ConnectionService.ts';
import type { SecretsVault } from '../secrets/SecretsVault.ts';
import {
  readImportFile,
  storeImportedSecrets,
  type ConnectionExportDialogs,
} from './ConnectionExportService.ts';
import { lineInputProblem, lineToInput, parseLine, repickFor } from './connectionBulkAdd.ts';
import { decryptSelected, type ParsedExport, type SecretValues } from './connectionExportFormat.ts';
import type { CandidateRow } from './import/candidateRow.ts';
import { decryptCompassSecrets } from './import/compassCrypto.ts';
import { detect } from './import/detect.ts';
import { latelierRows } from './import/latelierSource.ts';
import { buildReview, directDefault, planRowNames } from './import/review.ts';
import {
  buildCollections,
  combineRow,
  findCollections,
  type FoundCollection,
} from './import/unknownJson.ts';

/** What a token holds between the steps. Rows and secrets stay here, never in the renderer. */
interface Pending {
  source: ImportSource;
  rows: CandidateRow[];
  /** Each row's `savedAs` as last reviewed ('' for an unusable row), so commit can report renames. */
  reviewed: string[];
  /** A L'Atelier export, whose sealed secrets `decryptSelected` opens. */
  file?: ParsedExport;
  /** An Unknown JSON file's collections, for the Field Mapping step. */
  collections?: FoundCollection[];
}

/** A row's secrets opened at commit, and the names of those it had no place for. */
interface Opened {
  secrets: SecretValues;
  dropped: string[];
}

const EXPIRED = 'This import has expired. Choose the file again.';

/** A pasted line as a candidate row; its password moves to `secrets`. */
function uriRow(uri: string): CandidateRow {
  const line = parseLine(uri);
  const base = { nameHint: '', explicitDirect: false, multiHost: false, warnings: [], repick: [] };
  if (!line.ok) return { ...base, input: {}, secrets: {}, defaultTicked: false, unusable: line.reason };
  const { password, ...input } = line.input;
  return {
    ...base,
    input,
    secrets: password ? { password } : {},
    explicitDirect: line.explicitDirect,
    multiHost: line.multiHost,
    warnings: line.warnings,
    repick: line.repick,
    defaultTicked: true,
  };
}

/**
 * The Import Wizard (C14). Main owns the open dialog, the file and every
 * secret in it; the renderer holds only a token, field paths, masked samples
 * and row summaries. Every source ends in the same review and commit.
 */
export class ImportWizardService {
  private readonly conns: ConnectionService;
  private readonly vault: SecretsVault;
  private readonly dialogs: Pick<ConnectionExportDialogs, 'openPath'>;
  private readonly log?: Logger;
  private readonly pending = new Map<string, Pending>();
  /** Bumped by every clearPending(), so a commit in flight can tell its token was cleared. */
  private generation = 0;

  constructor(opts: {
    conns: ConnectionService;
    vault: SecretsVault;
    dialogs: Pick<ConnectionExportDialogs, 'openPath'>;
    log?: Logger;
  }) {
    this.conns = opts.conns;
    this.vault = opts.vault;
    this.dialogs = opts.dialogs;
    this.log = opts.log;
  }

  /**
   * Called when the window closes, and when a new import starts: one wizard
   * runs at a time, so a token from a cancelled one must not keep its pasted
   * passwords or file secrets in memory.
   */
  clearPending(): void {
    this.pending.clear();
    this.generation++;
  }

  /** C14 §2: picks, reads and classifies a file. A refusal throws before a token exists. */
  async importOpen(): Promise<ImportOpenResult> {
    this.clearPending();
    const picked = await this.dialogs.openPath();
    if (picked === null) return { cancelled: true };
    const found = detect(await readImportFile(picked, this.log));
    if (found.source === 'unknown') {
      const collections = buildCollections(found.value);
      const { collections: held, ambiguous } = findCollections(found.value);
      const token = this.hold({
        source: 'unknown',
        rows: [],
        reviewed: [],
        collections: held,
      });
      return { token, source: 'unknown', collections, ...(ambiguous ? { ambiguousCollections: ambiguous } : {}) };
    }
    const pending: Pending =
      found.source === 'latelier'
        ? { source: 'latelier', rows: latelierRows(found.file), reviewed: [], file: found.file }
        : { source: 'compass', rows: found.rows, reviewed: [] };
    const review = this.review(pending);
    return { token: this.hold(pending), source: found.source, review };
  }

  /** C14 §5.6: applies a Field Mapping to the held file. Each call replaces the previous rows. */
  importMap(input: ImportMapInput): ImportMapResult {
    const pending = this.held(input.token);
    if (pending.source !== 'unknown') {
      throw new ValidationError('Only a file in an unrecognised format has fields to map.');
    }
    const collection = pending.collections!.find((c) => c.at === input.at);
    if (!collection) throw new ValidationError("That list of connections isn't in this file.");
    pending.rows = collection.rows.map((row) => combineRow(row, input.mapping));
    return { review: this.review(pending) };
  }

  /** C13 §7.1 as an Import Source: nothing is written, and a password is reported as present, never returned. */
  importUris(uris: readonly string[]): ImportUrisResult {
    this.clearPending();
    const pending: Pending = { source: 'uris', rows: uris.map(uriRow), reviewed: [] };
    const review = this.review(pending);
    return { token: this.hold(pending), review };
  }

  /**
   * C14 §7. Only a successful commit consumes the token: a wrong passphrase
   * (or none) puts it back so the user can retry or import without passwords.
   */
  async importCommit(input: ImportCommitInput): Promise<ImportCommitResult> {
    const pending = this.held(input.token);
    const indices = [...input.indices].sort((a, b) => a - b);
    if (new Set(indices).size !== indices.length) {
      throw new ValidationError('Each connection can only be imported once.');
    }
    if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= pending.rows.length)) {
      throw new ValidationError('The selection includes a connection that is not in the file.');
    }
    if (indices.some((i) => pending.rows[i]!.unusable !== undefined)) {
      throw new ValidationError("The selection includes a connection that can't be imported.");
    }

    // Single-use even under concurrent commits: taken out before the first await.
    this.pending.delete(input.token);
    const generation = this.generation;
    let opened: Map<number, Opened>;
    try {
      opened = input.withoutSecrets
        ? new Map()
        : await this.openSealed(pending, indices, input.passphrase);
    } catch (err) {
      // Not when the window closed meanwhile: its tokens must not outlive it.
      if (this.generation === generation) this.pending.set(input.token, pending);
      throw err;
    }

    // The review was a forecast; clashes are resolved against what exists now,
    // over every usable row as the review did.
    const names = planRowNames(
      this.conns.list().map((c) => c.name),
      pending.rows,
    );
    const creds = new Map(input.credentials.map((c) => [c.index, c]));
    const direct = new Map(input.directConnection.map((d) => [d.index, d.value]));
    const result: ImportCommitResult = {
      created: [],
      renamed: [],
      skipped: [],
      repick: [],
      secretsNotStored: [],
      warnings: [],
    };
    for (const i of indices) {
      const row = pending.rows[i]!;
      const name = names[i]!.savedAs;
      const sealed = opened.get(i);
      const secrets: SecretValues = { ...row.secrets, ...sealed?.secrets };
      const { password, ...conn } = lineToInput(
        { input: { ...row.input, ...(secrets.password ? { password: secrets.password } : {}) } },
        name,
        {
          // A L'Atelier export carries its own Read-only (C14 §6).
          readOnly: pending.source === 'latelier' ? row.input.readOnly! : input.readOnly,
          directConnection: direct.get(i) ?? directDefault(row) ?? false,
        },
        creds.get(i),
      );
      const problem = lineInputProblem({ ...conn, ...(password ? { password } : {}) });
      if (problem) {
        result.skipped.push({ index: i, name, reason: problem });
        continue;
      }
      let created;
      try {
        created = await this.conns.create(conn);
      } catch (err) {
        // Carry on: the rows already created stay, so the result must say which did not.
        this.log?.error('conn-import', 'could not create an imported connection', {
          index: i,
          cause: err instanceof Error ? err.message : String(err),
        });
        result.skipped.push({
          index: i,
          name,
          reason: err instanceof AppError ? err.message : 'Unexpected error',
        });
        continue;
      }
      result.created.push({ index: i, id: created.id, name: created.name });
      if (created.name !== pending.reviewed[i]) {
        result.renamed.push({ index: i, from: pending.reviewed[i]!, to: created.name });
      }
      const files = repickFor(conn, row.repick);
      if (files.length > 0) result.repick.push({ name: created.name, files });
      for (const field of sealed?.dropped ?? []) {
        result.warnings.push({ name: created.name, message: `The "${field}" secret was not imported.` });
      }
      storeImportedSecrets(
        this.vault,
        this.log,
        created,
        { password, sshPassword: secrets.sshPassword, sshPassphrase: secrets.sshPassphrase },
        result.secretsNotStored,
      );
    }
    return result;
  }

  private held(token: string): Pending {
    const pending = this.pending.get(token);
    if (!pending) throw new ValidationError(EXPIRED);
    return pending;
  }

  private hold(pending: Pending): string {
    const token = randomUUID();
    this.pending.set(token, pending);
    return token;
  }

  /** Reviews the rows against the Connections that exist now, remembering the names it promised. */
  private review(pending: Pending): Review {
    const review = buildReview(
      pending.rows,
      this.conns.list().map((c) => c.name),
    );
    pending.reviewed = review.rows.map((r) => (r.ok ? r.savedAs : ''));
    return review;
  }

  /**
   * Opens the sealed secrets of the ticked rows, all before anything is
   * written. Any failure throws, so the caller writes nothing.
   */
  private async openSealed(
    pending: Pending,
    indices: readonly number[],
    passphrase: string | undefined,
  ): Promise<Map<number, Opened>> {
    if (pending.source === 'latelier') {
      const secrets = await decryptSelected(pending.file!, passphrase, indices);
      return new Map([...secrets].map(([i, values]) => [i, { secrets: values, dropped: [] }]));
    }
    const blobs = indices.flatMap((i) => {
      const sealed = pending.rows[i]!.sealed;
      return sealed?.kind === 'compass' ? [{ i, blob: sealed.blob }] : [];
    });
    if (blobs.length === 0) return new Map();
    if (!passphrase) throw new ValidationError('The export passphrase is required to import passwords.');
    return openCompassBlobs(blobs, passphrase);
  }
}

/** Key derivations in flight at once; libuv's pool has 4 threads and fs/DNS share it. */
const COMPASS_CONCURRENCY = 2;

/**
 * Every Compass entry has its own salt, so each blob costs one 100,000-round
 * derivation. The first runs alone: a wrong passphrase then fails after one
 * derivation with nothing else launched. The rest run a couple at a time, and
 * every launched job settles before this returns or throws, so no work
 * outlives the call and a retry never overlaps the previous attempt.
 */
async function openCompassBlobs(
  blobs: readonly { i: number; blob: string }[],
  passphrase: string,
): Promise<Map<number, Opened>> {
  const [first, ...rest] = blobs as [{ i: number; blob: string }, ...{ i: number; blob: string }[]];
  const opened = new Map<number, Opened>([[first.i, await decryptCompassSecrets(first.blob, passphrase)]]);
  let next = 0;
  let failure: { err: unknown } | undefined;
  // Workers never reject, so Promise.all below only returns once all are idle.
  const worker = async (): Promise<void> => {
    while (!failure && next < rest.length) {
      const { i, blob } = rest[next++]!;
      try {
        opened.set(i, await decryptCompassSecrets(blob, passphrase));
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: COMPASS_CONCURRENCY }, worker));
  if (failure) throw failure.err;
  return opened;
}
