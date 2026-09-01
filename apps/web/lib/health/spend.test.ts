import { describe, expect, mock, test } from "bun:test";
import type { AvailableModelCost } from "@/lib/models";
import type { SpendEventRow } from "./spend";

// `lib/model-catalog.ts`, imported by `./spend`, imports `server-only`,
// which throws unconditionally when loaded outside a server component.
mock.module("server-only", () => ({}));

const spendModule = import("./spend");

const NOW = new Date("2026-08-04T12:00:00Z");

const PRICED_MODEL_COST: AvailableModelCost = {
  input: 3,
  output: 15,
  cache_read: 0.3,
};

function priceFor(modelId: string | null): AvailableModelCost | undefined {
  return modelId === "priced-model" ? PRICED_MODEL_COST : undefined;
}

function event(overrides: Partial<SpendEventRow>): SpendEventRow {
  return {
    modelId: "priced-model",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    createdAt: NOW,
    ...overrides,
  };
}

describe("aggregateSpend", () => {
  test("an instance with no events returns zeros", async () => {
    const { aggregateSpend } = await spendModule;
    const report = aggregateSpend([], 30, NOW, priceFor);

    expect(report).toEqual({
      windowDays: 30,
      totalCostUsd: 0,
      totalTokens: 0,
      unpricedTokens: 0,
    });
  });

  test("events aggregate into one instance-wide total", async () => {
    const { aggregateSpend } = await spendModule;
    const events: SpendEventRow[] = [
      event({ inputTokens: 1_000_000, outputTokens: 0 }),
      event({ inputTokens: 0, outputTokens: 1_000_000 }),
      event({ inputTokens: 2_000_000, outputTokens: 0 }),
    ];

    const report = aggregateSpend(events, 30, NOW, priceFor);

    expect(report.totalTokens).toBe(4_000_000);
    expect(report.totalCostUsd).toBeCloseTo(3 + 15 + 6, 5);
  });

  test("events outside the window are excluded", async () => {
    const { aggregateSpend } = await spendModule;
    const insideWindow = event({
      inputTokens: 1_000_000,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const outsideWindow = event({
      inputTokens: 1_000_000,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });

    const report = aggregateSpend(
      [insideWindow, outsideWindow],
      30,
      NOW,
      priceFor,
    );

    expect(report.totalTokens).toBe(1_000_000);
  });

  test("an event whose model has no known price contributes tokens but zero cost, and is reported unpriced", async () => {
    const { aggregateSpend } = await spendModule;
    const unpriced = event({
      modelId: "mystery-model",
      inputTokens: 500_000,
      outputTokens: 500_000,
    });

    const report = aggregateSpend([unpriced], 30, NOW, priceFor);

    expect(report.totalTokens).toBe(1_000_000);
    expect(report.totalCostUsd).toBe(0);
    expect(report.unpricedTokens).toBe(1_000_000);
  });

  test("a null model id is unpriced rather than throwing", async () => {
    const { aggregateSpend } = await spendModule;
    const report = aggregateSpend(
      [event({ modelId: null, inputTokens: 100, outputTokens: 100 })],
      30,
      NOW,
      priceFor,
    );

    expect(report.unpricedTokens).toBe(200);
    expect(report.totalCostUsd).toBe(0);
  });
});
