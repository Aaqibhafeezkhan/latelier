import {
  entryToConnectionInput,
  SECRET_FIELDS,
  type ParsedExport,
} from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';

/**
 * A L'Atelier Connection Export's entries as candidate rows. The file names
 * its sealed fields in clear, so the review can say which secrets a row has;
 * the values stay sealed until commit. Every setting, `directConnection` and
 * `readOnly` included, is the exported Connection's own.
 */
export function latelierRows(file: ParsedExport): CandidateRow[] {
  return file.connections.map((entry) => {
    const fields = SECRET_FIELDS.filter((f) => entry.secrets?.[f] !== undefined);
    return {
      input: entryToConnectionInput(entry),
      secrets: {},
      ...(fields.length > 0 ? { sealed: { kind: 'latelier' as const, fields } } : {}),
      nameHint: entry.name,
      explicitDirect: true,
      multiHost: false,
      warnings: [],
      repick: entry.repick ?? [],
      defaultTicked: true,
    };
  });
}
