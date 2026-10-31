/**
 * AppError — base class for every error thrown inside the main process that
 * is intended to cross the IPC boundary. Each subclass carries a stable
 * machine-readable `code` that the renderer can switch on.
 */

export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'MONGO_ERROR'
  | 'DB_ERROR'
  | 'SECRETS_UNAVAILABLE'
  | 'SECRET_DECRYPT_FAILED'
  // Encrypted local columns: a cell that fails to open, a column key the keychain will not unwrap.
  | 'COLUMN_DECRYPT_FAILED'
  | 'COLUMN_KEY_UNREADABLE'
  // Connection Export (C13): the Export Passphrase did not decrypt the file.
  | 'BAD_PASSPHRASE'
  | 'READ_ONLY'
  // Audit Log Undo refusals (X13 §6).
  | 'AUDIT_NOT_REVERSIBLE'
  | 'AUDIT_UNDO_EXPIRED'
  | 'AUDIT_ALREADY_UNDONE'
  | 'AUDIT_TARGET_CHANGED'
  | 'INTERNAL';

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

/**
 * Thrown when a write is attempted against a connection with its read_only
 * flag set. Not a ValidationError — the renderer needs to switch on this
 * specifically (see ADR 0005) rather than treat it like malformed input.
 */
export class ReadOnlyConnectionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('READ_ONLY', message, details);
    this.name = 'ReadOnlyConnectionError';
  }
}

export class SystemError extends AppError {
  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'SystemError';
  }
}

/** The Export Passphrase did not decrypt a Connection Export; retrying is expected. */
export class BadPassphraseError extends AppError {
  constructor(message: string) {
    super('BAD_PASSPHRASE', message);
    this.name = 'BadPassphraseError';
  }
}

export class MongoOpError extends AppError {
  constructor(
    code: AppErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(code, message, details);
    this.name = 'MongoOpError';
  }
}
