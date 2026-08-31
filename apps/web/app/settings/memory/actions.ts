"use server";

import type { z } from "zod";
import { instanceMemoryDir } from "@/lib/memory/paths";
import {
  deleteMemory,
  listMemory,
  type MemoryEntry,
  writeMemory,
} from "@/lib/memory/store";
import { memoryDeleteSchema, memoryEditSchema } from "./memory-schemas";

export type MemoryActionResult =
  | { success: true }
  | { success: false; error: string };

const NOT_FOUND_ERROR = "That memory entry no longer exists.";

/**
 * Turns a Zod failure into this page's `{ success: false }` shape, keeping
 * the first field message so the user is told what is actually wrong.
 */
function toValidationFailure(error: z.ZodError): MemoryActionResult {
  return {
    success: false,
    error: error.issues[0]?.message ?? "That change couldn't be saved.",
  };
}

/** Newest first, so an edit or a fresh distillation surfaces at the top. */
function newestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** This instance's memory. */
export async function listInstanceMemory(): Promise<MemoryEntry[]> {
  return newestFirst(await listMemory(instanceMemoryDir()));
}

/**
 * Edits an entry's body in place. The title is preserved (so the write is
 * an update to the same file, not a rename), and the edit itself always
 * sets `source: "manual"` — even a distilled entry becomes manual the
 * moment a person hand-edits it.
 */
export async function editInstanceMemory(
  slug: string,
  body: string,
): Promise<MemoryActionResult> {
  const parsed = memoryEditSchema.safeParse({ slug, body });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const dir = instanceMemoryDir();
  const existing = (await listMemory(dir)).find(
    (entry) => entry.slug === parsed.data.slug,
  );
  if (!existing) {
    return { success: false, error: NOT_FOUND_ERROR };
  }
  await writeMemory(dir, {
    title: existing.title,
    body: parsed.data.body,
    source: "manual",
  });
  return { success: true };
}

/** Deletes one of this instance's memory entries. */
export async function deleteInstanceMemory(
  slug: string,
): Promise<MemoryActionResult> {
  const parsed = memoryDeleteSchema.safeParse({ slug });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const deleted = await deleteMemory(instanceMemoryDir(), parsed.data.slug);
  return deleted
    ? { success: true }
    : { success: false, error: NOT_FOUND_ERROR };
}
