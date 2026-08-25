import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { AgentBackend, TurnContext } from "./interface.ts";

export interface ConformanceSetup {
  backend: AgentBackend;
  /** Must produce a turn that emits ≥1 chunk and, until steered/interrupted, stays open. */
  turnContext: TurnContext;
  /**
   * A turn context that runs to natural completion on its own — no steer,
   * no interrupt. REQUIRED when `backend.capabilities().steering ===
   * "none"`: such a backend has no way to be told to wrap up, so the
   * completed-turn cases need a turn that finishes by itself. Unused (and
   * optional) for "restart" backends, which steer their way to a finish
   * instead.
   */
  finishableTurnContext?: TurnContext;
  /**
   * Backend instance to pair with `finishableTurnContext`, for the common
   * case where "does this turn hold open" is a property of the backend
   * instance rather than the turn context (e.g. FakeBackend's `holdOpen` is
   * per-config, not per-`TurnContext`). Defaults to `backend`. Must declare
   * the same capabilities as `backend`.
   */
  finishableBackend?: AgentBackend;
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

function requireFinishable(
  name: string,
  setup: ConformanceSetup,
): { backend: AgentBackend; turnContext: TurnContext } {
  if (!setup.finishableTurnContext) {
    throw new Error(
      `runBackendConformance("${name}"): a steering:"none" backend must supply finishableTurnContext (a turn that completes on its own, e.g. without holdOpen) for this case`,
    );
  }
  return {
    backend: setup.finishableBackend ?? setup.backend,
    turnContext: setup.finishableTurnContext,
  };
}

/**
 * The backend contract, as executable tests. Passing this suite is the
 * definition of done for an AgentBackend implementation.
 */
export function runBackendConformance(
  name: string,
  factory: ConformanceFactory,
): void {
  // A one-off probe call, purely to decide which cases below apply to this
  // backend's declared steering mode. Every case still calls `factory()`
  // fresh for its own backend/turn instances.
  const declaredCaps = factory().backend.capabilities();
  const steersToFinish = declaredCaps.steering === "restart";

  describe(`AgentBackend conformance: ${name}`, () => {
    test("declares coherent capabilities", () => {
      const { backend } = factory();
      const caps = backend.capabilities();
      expect(caps.id.length).toBeGreaterThan(0);
      expect(["restart", "none"]).toContain(caps.steering);
      expect(typeof caps.resume).toBe("boolean");
      expect(typeof caps.mcp).toBe("boolean");
      expect(typeof caps.effort).toBe("boolean");
      expect(typeof caps.subagents).toBe("boolean");
    });

    test("a steered or completed turn emits chunks then settles result", async () => {
      const setup = factory();
      const caps = setup.backend.capabilities();
      const { backend, turnContext } = steersToFinish
        ? setup
        : requireFinishable(name, setup);
      const handle = backend.startTurn(turnContext);
      if (caps.steering === "restart") {
        await handle.steer("wrap up");
      }
      const chunks = await collect(handle.chunks);
      expect(chunks.length).toBeGreaterThan(0);
      const result = await handle.result;
      expect(FINISH_REASONS.has(result.finishReason)).toBe(true);
      expect(typeof result.isError).toBe("boolean");
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
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

    if (!steersToFinish) {
      test("rejected steer leaves the turn unaffected", async () => {
        const setup = factory();
        const { backend, turnContext } = requireFinishable(name, setup);
        const handle = backend.startTurn(turnContext);
        await expect(handle.steer("x")).rejects.toMatchObject({
          name: "SteeringUnsupportedError",
        });
        const chunks = await collect(handle.chunks);
        expect(chunks.length).toBeGreaterThan(0);
        const result = await handle.result;
        expect(FINISH_REASONS.has(result.finishReason)).toBe(true);
        expect(result.isError).toBe(false);
        expect(result.steered).toBeUndefined();
      });
    }

    test("resume declared ⇒ resumeToken returned", async () => {
      const setup = factory();
      const caps = setup.backend.capabilities();
      const { backend, turnContext } = steersToFinish
        ? setup
        : requireFinishable(name, setup);
      const handle = backend.startTurn(turnContext);
      if (caps.steering === "restart") {
        await handle.steer("finish");
      }
      await collect(handle.chunks);
      const result = await handle.result;
      if (caps.resume) {
        expect(typeof result.resumeToken).toBe("string");
        expect((result.resumeToken ?? "").length).toBeGreaterThan(0);
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

    test("result stays pending until chunks are consumed", async () => {
      const { backend, turnContext } = factory();
      const caps = backend.capabilities();
      const handle = backend.startTurn(turnContext);
      const iterator = handle.chunks[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);

      const status = await Promise.race([
        handle.result.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        Promise.resolve("pending" as const),
      ]);
      expect(status).toBe("pending");

      if (caps.steering === "restart") {
        await handle.steer("wrap up");
      } else {
        handle.interrupt();
      }

      // Keep pulling from the SAME iterator to a natural end. Abandoning it
      // early (break/return) is itself a contractual trigger for AbortError
      // (see interface.ts's TurnHandle doc comment), which would defeat the
      // point of this case.
      let next = await iterator.next();
      while (!next.done) {
        next = await iterator.next();
      }

      if (caps.steering === "restart") {
        const result = await handle.result;
        expect(result.steered).toEqual({ text: "wrap up" });
      } else {
        await expect(handle.result).rejects.toMatchObject({
          name: "AbortError",
        });
      }
    });
  });
}
