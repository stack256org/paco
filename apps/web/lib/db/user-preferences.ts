import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { db } from "./client";
import { userPreferences, type UserPreferences } from "./schema";

export type DiffMode = "unified" | "split";

export interface UserPreferencesData {
  defaultModelId: string;
  defaultDiffMode: DiffMode;
  autoCommitLocal: boolean;
  autoCommitPush: boolean;
  autoCreatePr: boolean;
  alertsEnabled: boolean;
  alertSoundEnabled: boolean;
}

const DEFAULT_PREFERENCES: UserPreferencesData = {
  defaultModelId: APP_DEFAULT_MODEL_ID,
  defaultDiffMode: "unified",
  // A local commit has no outward-facing consequence, so it defaults on;
  // pushing publishes, so it does not.
  autoCommitLocal: true,
  autoCommitPush: false,
  autoCreatePr: false,
  alertsEnabled: true,
  alertSoundEnabled: true,
};

const VALID_DIFF_MODES: DiffMode[] = ["unified", "split"];

function normalizeDiffMode(value: unknown): DiffMode {
  if (
    typeof value === "string" &&
    VALID_DIFF_MODES.includes(value as DiffMode)
  ) {
    return value as DiffMode;
  }

  return DEFAULT_PREFERENCES.defaultDiffMode;
}

export function toUserPreferencesData(
  row?: Pick<
    UserPreferences,
    | "defaultModelId"
    | "defaultDiffMode"
    | "autoCommitLocal"
    | "autoCommitPush"
    | "autoCreatePr"
    | "alertsEnabled"
    | "alertSoundEnabled"
  >,
): UserPreferencesData {
  return {
    defaultModelId: row?.defaultModelId ?? DEFAULT_PREFERENCES.defaultModelId,
    defaultDiffMode: normalizeDiffMode(row?.defaultDiffMode),
    autoCommitLocal:
      row?.autoCommitLocal ?? DEFAULT_PREFERENCES.autoCommitLocal,
    autoCommitPush: row?.autoCommitPush ?? DEFAULT_PREFERENCES.autoCommitPush,
    autoCreatePr: row?.autoCreatePr ?? DEFAULT_PREFERENCES.autoCreatePr,
    alertsEnabled: row?.alertsEnabled ?? DEFAULT_PREFERENCES.alertsEnabled,
    alertSoundEnabled:
      row?.alertSoundEnabled ?? DEFAULT_PREFERENCES.alertSoundEnabled,
  };
}

/**
 * Get user preferences, creating default preferences if none exist
 */
export async function getUserPreferences(
  userId: string,
): Promise<UserPreferencesData> {
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  return toUserPreferencesData(existing);
}

/**
 * Update user preferences, creating if they don't exist
 */
export async function updateUserPreferences(
  userId: string,
  updates: Partial<UserPreferencesData>,
): Promise<UserPreferencesData> {
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(userPreferences)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(userPreferences.userId, userId))
      .returning();

    return toUserPreferencesData(updated);
  }

  // Create new preferences
  const [created] = await db
    .insert(userPreferences)
    .values({
      id: nanoid(),
      userId,
      defaultModelId:
        updates.defaultModelId ?? DEFAULT_PREFERENCES.defaultModelId,
      defaultDiffMode:
        updates.defaultDiffMode ?? DEFAULT_PREFERENCES.defaultDiffMode,
      autoCommitLocal:
        updates.autoCommitLocal ?? DEFAULT_PREFERENCES.autoCommitLocal,
      autoCommitPush:
        updates.autoCommitPush ?? DEFAULT_PREFERENCES.autoCommitPush,
      autoCreatePr: updates.autoCreatePr ?? DEFAULT_PREFERENCES.autoCreatePr,
      alertsEnabled: updates.alertsEnabled ?? DEFAULT_PREFERENCES.alertsEnabled,
      alertSoundEnabled:
        updates.alertSoundEnabled ?? DEFAULT_PREFERENCES.alertSoundEnabled,
    })
    .returning();

  return toUserPreferencesData(created);
}
