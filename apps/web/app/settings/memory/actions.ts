"use server";

import { requireAdmin } from "@/lib/admin/require-admin";
import { SIGNED_OUT } from "@/lib/error-copy";
import { orgMemoryDir, userMemoryDir } from "@/lib/memory/paths";
import {
  deleteMemory,
  listMemory,
  type MemoryEntry,
  writeMemory,
} from "@/lib/memory/store";
import { getOrganization } from "@/lib/org/organization";
import { getServerSession } from "@/lib/session/get-server-session";

export type MemoryActionResult =
  | { success: true }
  | { success: false; error: string };

const NOT_FOUND_ERROR = "That memory entry no longer exists.";

/** Newest first, so an edit or a fresh distillation surfaces at the top. */
function newestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The signed-in caller's id, or a thrown error.
 *
 * Every other function below reaches its memory directory through this —
 * never through an id an argument could carry — so a user can only ever
 * see or touch their own user-scope memory. That is what "scope isolation"
 * means for this page: the path comes from the session, not from input.
 */
async function requireUserId(): Promise<string> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error(SIGNED_OUT);
  }
  return session.user.id;
}

async function requireOrganization() {
  const organization = await getOrganization();
  if (!organization) {
    throw new Error("There is no organisation yet.");
  }
  return organization;
}

/** The caller's own user-scope memory. */
export async function listUserMemory(): Promise<MemoryEntry[]> {
  const userId = await requireUserId();
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
  const userId = await requireUserId();
  const dir = userMemoryDir(userId);
  const existing = (await listMemory(dir)).find((entry) => entry.slug === slug);
  if (!existing) {
    return { success: false, error: NOT_FOUND_ERROR };
  }
  await writeMemory(dir, { title: existing.title, body, source: "manual" });
  return { success: true };
}

/** Deletes one of the caller's own user-scope entries. */
export async function deleteUserMemory(
  slug: string,
): Promise<MemoryActionResult> {
  const userId = await requireUserId();
  const deleted = await deleteMemory(userMemoryDir(userId), slug);
  return deleted
    ? { success: true }
    : { success: false, error: NOT_FOUND_ERROR };
}

/**
 * The organisation's shared memory — admin only, per `requireAdmin`
 * (`lib/admin/require-admin.ts`), the same gate every other admin-only
 * settings page uses.
 */
export async function listOrgMemory(): Promise<MemoryEntry[]> {
  await requireAdmin();
  const organization = await requireOrganization();
  return newestFirst(await listMemory(orgMemoryDir(organization.id)));
}

/** Edits an org entry's body in place; same manual-on-edit rule as the user section. */
export async function editOrgMemory(
  slug: string,
  body: string,
): Promise<MemoryActionResult> {
  await requireAdmin();
  const organization = await requireOrganization();
  const dir = orgMemoryDir(organization.id);
  const existing = (await listMemory(dir)).find((entry) => entry.slug === slug);
  if (!existing) {
    return { success: false, error: NOT_FOUND_ERROR };
  }
  await writeMemory(dir, { title: existing.title, body, source: "manual" });
  return { success: true };
}

/** Deletes one org-scope entry. */
export async function deleteOrgMemory(
  slug: string,
): Promise<MemoryActionResult> {
  await requireAdmin();
  const organization = await requireOrganization();
  const deleted = await deleteMemory(orgMemoryDir(organization.id), slug);
  return deleted
    ? { success: true }
    : { success: false, error: NOT_FOUND_ERROR };
}
