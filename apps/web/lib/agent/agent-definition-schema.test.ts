import { describe, expect, test } from "bun:test";
import type { ClaudeAgentDefinition } from "@paco/claude-code";
import { agentDefinitionSchema } from "./agent-definition-schema";

describe("agentDefinitionSchema", () => {
  test("round-trips a minimal valid definition", () => {
    const definition: ClaudeAgentDefinition = {
      description: "does a thing",
      prompt: "You are an agent.",
    };

    const parsed = agentDefinitionSchema.parse(definition);

    expect(parsed).toEqual(definition);
  });

  test("round-trips a fully populated valid definition", () => {
    const definition: ClaudeAgentDefinition = {
      description: "does a thing",
      prompt: "You are an agent.",
      model: "sonnet",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      effort: "high",
      maxTurns: 12,
    };

    const parsed = agentDefinitionSchema.parse(definition);

    expect(parsed).toEqual(definition);
  });

  test("rejects unknown fields", () => {
    const result = agentDefinitionSchema.safeParse({
      description: "does a thing",
      prompt: "You are an agent.",
      unknownField: "surprise",
    });

    expect(result.success).toBe(false);
  });

  test("rejects an invalid effort value", () => {
    const result = agentDefinitionSchema.safeParse({
      description: "does a thing",
      prompt: "You are an agent.",
      effort: "extreme",
    });

    expect(result.success).toBe(false);
  });

  test("rejects a missing required field", () => {
    const result = agentDefinitionSchema.safeParse({
      prompt: "You are an agent.",
    });

    expect(result.success).toBe(false);
  });

  test("rejects non-string entries in tools", () => {
    const result = agentDefinitionSchema.safeParse({
      description: "does a thing",
      prompt: "You are an agent.",
      tools: ["Read", 42],
    });

    expect(result.success).toBe(false);
  });
});
