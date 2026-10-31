import { AppError } from '../../errors.ts';
import type { Logger } from '../../log.ts';
import type { ColumnCipher } from '../columnCipher.ts';

/**
 * Opens a cell read by a list query. One cell that fails to decrypt must not
 * hide every other row, so it yields null and a warning that names the cell
 * by table, column and id — never its content — and the repository decides
 * what the row becomes. Single-row reads open directly and keep throwing,
 * except in WorkspaceTabRepo, where a tab must stay closable.
 */
export function openListedCell(
  cipher: ColumnCipher,
  log: Pick<Logger, 'warn'> | undefined,
  table: string,
  column: string,
  id: string,
  cell: string | Buffer,
): string | null {
  try {
    return cipher.open(table, column, id, cell);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'COLUMN_DECRYPT_FAILED') throw err;
    log?.warn('db', 'skipped an unreadable encrypted cell', { table, column, id });
    return null;
  }
}
