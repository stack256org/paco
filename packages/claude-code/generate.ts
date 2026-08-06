import type { ClaudeCodeOptions, ModelTier } from "./options.ts";
import { runClaudeCode } from "./run.ts";
import { isResultMessage } from "./types.ts";

export interface GenerateTextOptions {
  /** Working directory. Any readable path works for pure text generation. */
  cwd: string;
  /** Model tier. Defaults to `haiku`, which suits short utility generations. */
  model?: ModelTier;
  /** Extra guidance appended to the default system prompt. */
  appendSystemPrompt?: string;
  /** Replaces the default system prompt entirely. */
  systemPrompt?: string;
  /** JSON Schema; when set, the result is parsed structured output. */
  jsonSchema?: Record<string, unknown>;
  /** Path to the `claude` executable. */
  executable?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

/**
 * One-shot text generation through the Claude Code CLI.
 *
 * Replaces the AI-SDK `generateText` calls used for titles, commit messages,
 * and PR bodies. Tools are disabled and turns capped at one, so this is a plain
 * prompt-in/text-out call with no agentic loop and no extra token spend.
 */
export async function generateText(
  prompt: string,
  options: GenerateTextOptions,
  signal?: AbortSignal,
): Promise<string> {
  const runOptions: ClaudeCodeOptions = {
    cwd: options.cwd,
    model: options.model ?? "haiku",
    maxTurns: 1,
    // No tools: this is text generation, not agentic work.
    tools: [],
    ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
    ...(options.appendSystemPrompt && {
      appendSystemPrompt: options.appendSystemPrompt,
    }),
    ...(options.jsonSchema && { jsonSchema: options.jsonSchema }),
    ...(options.executable && { executable: options.executable }),
    ...(options.env && { env: options.env }),
  };

  const run = runClaudeCode(prompt, runOptions, signal);

  // The stream must be drained for the terminal result to arrive.
  for await (const message of run.messages) {
    if (isResultMessage(message)) {
      break;
    }
  }

  const result = await run.result;

  if (result.is_error) {
    throw new Error(
      `Claude Code generation failed (${result.subtype}): ${result.result ?? "no output"}`,
    );
  }

  return (result.result ?? "").trim();
}

/**
 * Structured generation validated against a JSON Schema.
 *
 * Uses the CLI's `--json-schema` support, so the model is constrained rather
 * than asked to emit JSON and hoped for.
 */
export async function generateObject<T>(
  prompt: string,
  schema: Record<string, unknown>,
  options: GenerateTextOptions,
  signal?: AbortSignal,
): Promise<T> {
  const run = runClaudeCode(
    prompt,
    {
      cwd: options.cwd,
      model: options.model ?? "haiku",
      maxTurns: 1,
      tools: [],
      jsonSchema: schema,
      ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt && {
        appendSystemPrompt: options.appendSystemPrompt,
      }),
      ...(options.executable && { executable: options.executable }),
      ...(options.env && { env: options.env }),
    },
    signal,
  );

  for await (const message of run.messages) {
    if (isResultMessage(message)) {
      break;
    }
  }

  const result = await run.result;

  if (result.is_error) {
    throw new Error(
      `Claude Code structured generation failed (${result.subtype})`,
    );
  }

  if (result.structured_output !== undefined) {
    return result.structured_output as T;
  }

  // Older CLI builds return the JSON in `result` instead of `structured_output`.
  try {
    return JSON.parse(result.result ?? "") as T;
  } catch {
    throw new Error("Claude Code returned no parseable structured output");
  }
}
