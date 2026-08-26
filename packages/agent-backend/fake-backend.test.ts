import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { FakeBackend } from "./fake-backend.ts";

async function collect(chunks: AsyncIterable<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

describe("FakeBackend", () => {
  test("streams scripted chunks then resolves result", async () => {
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
        { type: "text-end", id: "t1" },
      ],
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    const chunks = await collect(handle.chunks);
    expect(chunks).toHaveLength(3);
    const result = await handle.result;
    expect(result.finishReason).toBe("stop");
    expect(result.resumeToken).toBe("fake-session-1");
  });

  test("interrupt rejects result with AbortError", async () => {
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    handle.interrupt();
    expect(collect(handle.chunks)).resolves.toBeDefined();
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("steer resolves result with steered payload", async () => {
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    await handle.steer("change of plan");
    await collect(handle.chunks);
    const result = await handle.result;
    expect(result.steered).toEqual({ text: "change of plan" });
    expect(result.isError).toBe(false);
  });

  test("steering none rejects steer and turn continues", async () => {
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-end", id: "t1" },
      ],
      steering: "none",
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    await expect(handle.steer("nope")).rejects.toMatchObject({
      name: "SteeringUnsupportedError",
    });
    await collect(handle.chunks);
    const result = await handle.result;
    expect(result.steered).toBeUndefined();
  });

  test("abort signal in context aborts the turn", async () => {
    const controller = new AbortController();
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({
      cwd: "/tmp",
      prompt: "hi",
      abortSignal: controller.signal,
    });
    controller.abort();
    await collect(handle.chunks);
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abandoning chunks rejects result", async () => {
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
      ],
      holdOpen: true,
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    // Consume exactly one chunk, then abandon iteration early (the
    // async-iterator equivalent of `for await (...) { break; }`).
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("pre-aborted signal wins in the non-holdOpen path", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-end", id: "t1" },
      ],
    });
    const handle = backend.startTurn({
      cwd: "/tmp",
      prompt: "hi",
      abortSignal: controller.signal,
    });
    await collect(handle.chunks);
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });
});
