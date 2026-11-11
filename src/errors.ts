export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
  ) {
    super(errorCode);
  }
}

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // pg also reports closed connections without a SQLSTATE or socket error code.
  if ([
    "Connection terminated",
    "Connection terminated unexpectedly",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ].includes(error.message)) return true;
  const code = "code" in error ? String(error.code) : "";
  return code.startsWith("08") || [
    "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND",
    "57P01", "57P02", "57P03", "53300",
  ].includes(code);
}
