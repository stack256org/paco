import "server-only";

import {
  generateObject as claudeGenerateObject,
  generateText as claudeGenerateText,
  type ModelTier,
} from "@paco/claude-code";
import type { z } from "zod";

/**
 * Utility-model generation for short, non-agentic tasks: session titles,
 * commit messages, PR titles and bodies.
 *
 * Runs through the Claude Code CLI on the host rather than a hosted gateway, so
 * these calls reuse the same subscription auth as the main agent and need no
 * API key. Tools are disabled and turns capped at one.
 */

/** Where the CLI runs for utility generation. Nothing is read from disk. */
function utilityCwd(): string {
  return process.cwd();
}

/** Model tier for utility generation. Cheap and fast by default. */
const UTILITY_MODEL: ModelTier = "haiku";

export async function generateText(params: {
  prompt: string;
  model?: ModelTier;
  system?: string;
  signal?: AbortSignal;
}): Promise<{ text: string }> {
  const text = await claudeGenerateText(
    params.prompt,
    {
      cwd: utilityCwd(),
      model: params.model ?? UTILITY_MODEL,
      ...(params.system && { appendSystemPrompt: params.system }),
    },
    params.signal,
  );

  return { text };
}

/**
 * Schema-constrained generation.
 *
 * The Zod schema is converted to JSON Schema and enforced by the CLI's
 * `--json-schema` flag, then re-validated locally so a malformed payload fails
 * here rather than downstream.
 */
export async function generateObject<T extends z.ZodType>(params: {
  prompt: string;
  schema: T;
  model?: ModelTier;
  system?: string;
  signal?: AbortSignal;
}): Promise<{ output: z.infer<T> }> {
  const { z: zod } = await import("zod");
  const jsonSchema = zod.toJSONSchema(params.schema) as Record<string, unknown>;

  const raw = await claudeGenerateObject<unknown>(
    params.prompt,
    jsonSchema,
    {
      cwd: utilityCwd(),
      model: params.model ?? UTILITY_MODEL,
      ...(params.system && { appendSystemPrompt: params.system }),
    },
    params.signal,
  );

  return { output: params.schema.parse(raw) as z.infer<T> };
}
