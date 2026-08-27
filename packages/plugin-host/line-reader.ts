/**
 * Newline framing for a plugin worker's stdout, with a cap on how long one
 * line may be.
 *
 * Its own unit, rather than a closure inside the host, because the bug it
 * exists to prevent is a function of where the pipe happens to split the
 * stream — and that is decided by the kernel, not by anything a test of the
 * host can arrange. Split here, the chunk boundary is an argument.
 *
 * The host previously measured the cap only against what was left over after
 * every complete line had been consumed. That catches a flood with no newline
 * in it, which is the case it was written for, and misses the same flood with
 * a newline at the end: the whole thing is taken as one line, the leftover is
 * empty, and the cap has nothing to measure. Whether a given flood had a
 * newline in the same read was a platform difference — macOS delivered 64 KiB
 * at a time and tripped the cap on the second chunk, Linux coalesced reads and
 * did not — so the protection held on a developer's machine and not on CI or,
 * more to the point, in production on a customer's Linux host.
 */

/**
 * The longest single line a worker may write. A worker that exceeds it is
 * killed: past this point it is either broken or hostile, and the host has no
 * way to tell which. 64 KiB is far above any legitimate message — the protocol
 * caps tool names, descriptions and counts well below it — and far below a
 * size that threatens the host's memory.
 */
export const MAX_LINE_BYTES = 65_536;

export type LineReaderOptions = {
  /** Called with each complete line, newline stripped. */
  onLine: (line: string) => void;
  /**
   * Called once, when a line exceeds `MAX_LINE_BYTES`. The reader closes
   * itself first, so nothing further is delivered: a stream that cannot frame
   * itself has stopped being evidence of anything, and the messages after the
   * offending line are as untrustworthy as the line itself.
   */
  onOverflow: (message: string) => void;
};

export type LineReader = {
  /** Feeds one chunk of decoded stdout. */
  push: (chunk: string) => void;
  /** Stops delivery. Idempotent, and safe to call from `onLine`. */
  close: () => void;
};

export function readLines({
  onLine,
  onOverflow,
}: LineReaderOptions): LineReader {
  let buffer = "";
  let closed = false;

  const overflow = (): void => {
    closed = true;
    buffer = "";
    onOverflow(`wrote more than ${MAX_LINE_BYTES} bytes without a newline`);
  };

  return {
    push(chunk: string): void {
      if (closed) {
        return;
      }
      buffer += chunk;

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        // Checked before the line is handed on, not after the buffer has been
        // drained: this is the case the host used to miss, and handing a
        // 200 KB "line" to JSON.parse is exactly what the cap exists to
        // prevent.
        if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
          overflow();
          return;
        }

        onLine(line);
        if (closed) {
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }

      // A line still in progress. Capped too, or a worker that never writes a
      // newline at all would grow this buffer without limit.
      if (Buffer.byteLength(buffer, "utf-8") > MAX_LINE_BYTES) {
        overflow();
      }
    },

    close(): void {
      closed = true;
      buffer = "";
    },
  };
}
