import { describe, expect, test } from "bun:test";
import { MAX_LINE_BYTES, readLines } from "./line-reader.ts";

/**
 * Feeds `chunks` through a reader and reports what the host would have seen.
 * Every case here is the same 200 KB flood under a different chunking, because
 * the chunking is the whole variable: the pipe decides it, and Linux and macOS
 * decide it differently.
 */
function feed(chunks: string[]): { lines: string[]; overflow: boolean } {
  const lines: string[] = [];
  let overflow = false;
  const reader = readLines({
    onLine: (line) => lines.push(line),
    onOverflow: () => {
      overflow = true;
    },
  });
  for (const chunk of chunks) {
    reader.push(chunk);
  }
  return { lines, overflow };
}

const READY = `${JSON.stringify({ kind: "ready", tools: [] })}\n`;

describe("readLines", () => {
  test("passes ordinary newline-terminated lines straight through", () => {
    const { lines, overflow } = feed(['{"a":1}\n{"b":2}\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(overflow).toBe(false);
  });

  test("reassembles a line split across chunks", () => {
    const { lines, overflow } = feed(['{"a":', "1}", "\n"]);
    expect(lines).toEqual(['{"a":1}']);
    expect(overflow).toBe(false);
  });

  test("a line exactly at the cap is allowed through", () => {
    const line = "x".repeat(MAX_LINE_BYTES);
    const { lines, overflow } = feed([`${line}\n`]);
    expect(overflow).toBe(false);
    expect(lines).toEqual([line]);
  });

  /**
   * The unterminated flood. This is the case the host was written for and the
   * only one it actually caught: nothing has a newline, so the cap is measured
   * against a buffer that only grows.
   */
  test("overflows on an unterminated flood delivered in pipe-sized chunks", () => {
    const blob = "x".repeat(200_000);
    const chunks: string[] = [];
    for (let at = 0; at < blob.length; at += 65_536) {
      chunks.push(blob.slice(at, at + 65_536));
    }
    const { lines, overflow } = feed(chunks);
    expect(overflow).toBe(true);
    expect(lines).toEqual([]);
  });

  /**
   * The same flood, terminated. This is what a Linux runner delivers — reads
   * coalesce, so the blob and the newline of the message after it arrive in one
   * `data` event — and it is what the host used to let through: the whole blob
   * was consumed as a single line, handed to JSON.parse, and left an empty
   * buffer for the cap to measure. `apt`-visible symptom: the plugin never
   * reached ready, because its `ready` message was swallowed inside the
   * oversized line.
   */
  test("overflows on a flood that ends in a newline, in one chunk", () => {
    const blob = "x".repeat(200_000);
    const { lines, overflow } = feed([blob + READY]);
    expect(overflow).toBe(true);
    expect(lines).toEqual([]);
  });

  test("overflows on an oversized line even when more lines follow it", () => {
    const blob = "x".repeat(200_000);
    const { lines, overflow } = feed([`${blob}\n${READY}`]);
    expect(overflow).toBe(true);
    // Nothing after the offending line is delivered: the worker is being
    // killed, and handing its later messages to the host would be acting on a
    // stream that has already proved it cannot be trusted to frame itself.
    expect(lines).toEqual([]);
  });

  test("measures bytes rather than UTF-16 code units", () => {
    // Each "é" is one code unit and two bytes, so a string of MAX_LINE_BYTES
    // code units is twice the cap in bytes. Measuring `.length` would let this
    // through.
    const line = "é".repeat(MAX_LINE_BYTES);
    const { overflow } = feed([`${line}\n`]);
    expect(overflow).toBe(true);
  });

  test("stops delivering lines once the consumer closes the reader", () => {
    const lines: string[] = [];
    const reader = readLines({
      onLine: (line) => {
        lines.push(line);
        reader.close();
      },
      onOverflow: () => {
        // not reached
      },
    });
    reader.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  test("reports overflow once, not once per subsequent chunk", () => {
    let overflows = 0;
    const reader = readLines({
      onLine: () => {
        // not reached
      },
      onOverflow: () => {
        overflows += 1;
      },
    });
    reader.push("x".repeat(200_000));
    reader.push("x".repeat(200_000));
    expect(overflows).toBe(1);
  });
});
