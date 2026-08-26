/**
 * Typed error for the Poolside ACP transport: either a JSON-RPC error
 * response (`code`/`data` straight off the wire) or a transport-level
 * failure — the `pool` process exited, failed to spawn, or its stdio broke
 * before responding — which carries neither.
 *
 * Its own file because this package's lint config caps one class per file,
 * and `acp-client.ts` spends its allowance on `AcpClient`.
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
