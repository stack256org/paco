"use server";

import { z } from "zod";
import { getSoleUserId } from "@/lib/db/users";
import { orgMemoryDir, userMemoryDir } from "@/lib/memory/paths";
import {
  deleteMemory,
  listMemory,
  type MemoryEntry,
  writeMemory,
} from "@/lib/memory/store";
import { getOrganization } from "@/lib/org/organization";
import { memoryDeleteSchema, memoryEditSchema } from "./memory-schemas";

export type MemoryActionResult =
  | { success: true }
  | { success: false; error: string };

const NOT_FOUND_ERROR = "That memory entry no longer exists.";

/**
 * Turns a Zod failure into this page's `{ success: false }` shape, keeping
 * the first field message so the user is told what is actually wrong.
 *
 * Validation always runs *after* the authorization gate, never before: a
 * caller with no right to the org section must be rejected as unauthorized,
 * not handed a field error that confirms the entry exists.
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

/** This instance's user-scope memory. */
export async function listUserMemory(): Promise<MemoryEntry[]> {
  const userId = await getSoleUserId();
  return newestFirst(await listMemory(userMemoryDir(userId)));
}

/**
 * Edits an entry's body in place. The title is preserved (so the write is
 * an update to the same file, not a rename), and the edit itself always
 * sets `source: "manual"` — even a distilled or promoted entry becomes
 * manual the moment a person hand-edits it.
 */
export async function editUserMemory(
  slug: string,
  body: string,
): Promise<MemoryActionResult> {
  const userId = await getSoleUserId();
  const parsed = memoryEditSchema.safeParse({ slug, body });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const dir = userMemoryDir(userId);
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

/** Deletes one of the caller's own user-scope entries. */
export async function deleteUserMemory(
  slug: string,
): Promise<MemoryActionResult> {
  const userId = await getSoleUserId();
  const parsed = memoryDeleteSchema.safeParse({ slug });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const deleted = await deleteMemory(userMemoryDir(userId), parsed.data.slug);
  return deleted
    ? { success: true }
    : { success: false, error: NOT_FOUND_ERROR };
}

/** The organisation's shared memory. */
export async function listOrgMemory(): Promise<MemoryEntry[]> {
  const organization = await getOrganization();
  return newestFirst(await listMemory(orgMemoryDir(organization.id)));
}

/** Edits an org entry's body in place; same manual-on-edit rule as the user section. */
export async function editOrgMemory(
  slug: string,
  body: string,
): Promise<MemoryActionResult> {
  const parsed = memoryEditSchema.safeParse({ slug, body });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const organization = await getOrganization();
  const dir = orgMemoryDir(organization.id);
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

/** Deletes one org-scope entry. */
export async function deleteOrgMemory(
  slug: string,
): Promise<MemoryActionResult> {
  const parsed = memoryDeleteSchema.safeParse({ slug });
  if (!parsed.success) {
    return toValidationFailure(parsed.error);
  }
  const organization = await getOrganization();
  const deleted = await deleteMemory(
    orgMemoryDir(organization.id),
    parsed.data.slug,
  );
  return deleted
    ? { success: true }
    : { success: false, error: NOT_FOUND_ERROR };
}
