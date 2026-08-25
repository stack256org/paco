import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { AgentBackend, TurnContext } from "./interface.ts";

export interface ConformanceSetup {
  backend: AgentBackend;
  /** Must produce a turn that emits ≥1 chunk and, until steered/interrupted, stays open. */
  turnContext: TurnContext;
}

export type ConformanceFactory = () => ConformanceSetup;

async function collect(chunks: AsyncIterable<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

const FINISH_REASONS = new Set(["stop", "length", "error", "tool-calls"]);

/**
 * The backend contract, as executable tests. Passing this suite is the
 * definition of done for an AgentBackend implementation.
 */
export function runBackendConformance(
  name: string,
  factory: ConformanceFactory,
): void {
  describe(`AgentBackend conformance: ${name}`, () => {
    test("declares coherent capabilities", () => {
      const { backend } = factory();
      const caps = backend.capabilities();
      expect(caps.id.length).toBeGreaterThan(0);
      expect(["restart", "none"]).toContain(caps.steering);
    });

    test("a steered or completed turn emits chunks then settles result", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      const caps = backend.capabilities();
      // A turn that stays open until steered/interrupted (per ConformanceSetup)
      // has no other way to wind down when steering is unsupported.
      if (caps.steering === "restart") {
        await handle.steer("wrap up");
      } else {
        handle.interrupt();
      }
      const chunks = await collect(handle.chunks).catch(() => []);
      expect(chunks.length).toBeGreaterThan(0);
      if (caps.steering === "restart") {
        const result = await handle.result;
        expect(FINISH_REASONS.has(result.finishReason)).toBe(true);
        expect(typeof result.isError).toBe("boolean");
        expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
        expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
      } else {
        await handle.result.catch(() => undefined);
      }
    });

    test("interrupt rejects result with AbortError", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      handle.interrupt();
      await collect(handle.chunks).catch(() => []);
      await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    });

    test("steer follows the declared capability", async () => {
      const { backend, turnContext } = factory();
      const caps = backend.capabilities();
      const handle = backend.startTurn(turnContext);
      if (caps.steering === "restart") {
        await handle.steer("different direction");
        await collect(handle.chunks);
        const result = await handle.result;
        expect(result.steered).toEqual({ text: "different direction" });
        expect(result.isError).toBe(false);
      } else {
        await expect(handle.steer("x")).rejects.toMatchObject({
          name: "SteeringUnsupportedError",
        });
        handle.interrupt();
        await collect(handle.chunks).catch(() => []);
        await handle.result.catch(() => undefined);
      }
    });

    test("resume declared ⇒ resumeToken returned", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      const caps = backend.capabilities();
      // As above: without "restart" steering, a held-open turn can only be
      // wound down via interrupt(), which rejects `result` and carries no
      // resumeToken — so the resume assertion only applies when the turn can
      // actually be steered to a normal finish.
      if (caps.steering === "restart") {
        await handle.steer("finish");
        await collect(handle.chunks);
        const result = await handle.result;
        if (caps.resume) {
          expect(typeof result.resumeToken).toBe("string");
          expect((result.resumeToken ?? "").length).toBeGreaterThan(0);
        }
      } else {
        handle.interrupt();
        await collect(handle.chunks).catch(() => []);
        await handle.result.catch(() => undefined);
      }
    });

    test("pre-aborted context signal rejects with AbortError", async () => {
      const { backend, turnContext } = factory();
      const controller = new AbortController();
      controller.abort();
      const handle = backend.startTurn({
        ...turnContext,
        abortSignal: controller.signal,
      });
      await collect(handle.chunks).catch(() => []);
      await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    });
  });
}
