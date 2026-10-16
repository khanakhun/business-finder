/** A value cannot be written to (or read from) a custom column type. */
export class ColumnValueError extends Error {
  constructor(column: string, message: string) {
    super(`${column}: ${message}`);
    this.name = 'ColumnValueError';
  }
}
