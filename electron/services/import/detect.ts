import { EJSON } from 'bson';
import { ValidationError } from '../../errors.ts';
import {
  EXPORT_FORMAT,
  MAX_FILE_BYTES,
  parseConnectionExport,
  type ParsedExport,
} from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';
import { isCompassExport, readCompass } from './compassReader.ts';

/** What a picked file turned out to be (C14 §2). */
export type Detected =
  | { source: 'latelier'; file: ParsedExport }
  | { source: 'compass'; rows: CandidateRow[] }
  | { source: 'unknown'; value: unknown };

/** C13's limit. Checked on the file's size before it is read, and on the text itself. */
export function checkFileSize(bytes: number): void {
  if (bytes > MAX_FILE_BYTES) {
    throw new ValidationError(
      `This file is too large to import (${MAX_FILE_BYTES / 1024 / 1024} MB limit).`,
    );
  }
}

/**
 * Classifies a file's text: a L'Atelier Connection Export, a Compass export,
 * or any other JSON. Throws `ValidationError` for anything that can't be
 * imported at all, so nothing is held for a file that fails here.
 */
export function detect(text: string): Detected {
  checkFileSize(Buffer.byteLength(text));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("This isn't a JSON file.");
  }
  if ((value as { format?: unknown } | null)?.format === EXPORT_FORMAT) {
    // Its own parse keeps C13 §1 whole: the newer-version refusal and the strict schema.
    return { source: 'latelier', file: parseConnectionExport(text) };
  }
  if (isCompassExport(value)) {
    // Canonical EJSON: `version` and ports are `{"$numberInt": …}` until EJSON reads them.
    let ejson: unknown;
    try {
      ejson = EJSON.parse(text);
    } catch {
      throw new ValidationError("This Compass export can't be read.");
    }
    return { source: 'compass', rows: readCompass(ejson) };
  }
  return { source: 'unknown', value };
}
