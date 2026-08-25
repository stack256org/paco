/**
 * Typed error for the OpenFX ACP transport: a JSON-RPC error response
 * (`code`/`data` from the wire — PROTOCOL.md §2 error codes) or a
 * transport-level failure (process exited/failed to spawn before
 * responding), which carries no `code`/`data`.
 *
 * Kept in its own file because this package's lint config caps one class
 * per file; `acp-client.ts` already spends its one class on `AcpClient`.
 */
export class AcpError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}
