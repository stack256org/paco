import { getServerSession } from "@/lib/session/get-server-session";
import {
  getUserPreferences,
  type DiffMode,
  updateUserPreferences,
} from "@/lib/db/user-preferences";
import { BAD_REQUEST, SIGNED_OUT } from "@/lib/error-copy";

/**
 * One message for every rejected field.
 *
 * The field names here are internal — `defaultModelId` means nothing to
 * someone looking at a dropdown labelled "Model" — and only a broken client
 * can send a bad value anyway, so naming the field would help nobody.
 */
const PREFERENCE_NOT_SAVED =
  "We couldn't save that setting. Reload the page and try again.";

interface UpdatePreferencesRequest {
  defaultModelId?: string;
  defaultDiffMode?: DiffMode;
  autoCommitLocal?: boolean;
  autoCommitPush?: boolean;
  autoCreatePr?: boolean;
  alertsEnabled?: boolean;
  alertSoundEnabled?: boolean;
}

export async function GET() {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const preferences = await getUserPreferences(session.user.id);
  return Response.json({ preferences });
}

export async function PATCH(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  let body: UpdatePreferencesRequest;
  try {
    body = (await req.json()) as UpdatePreferencesRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const updates: UpdatePreferencesRequest = {};

  if (body.defaultDiffMode !== undefined) {
    const validDiffModes = ["unified", "split"];
    if (
      typeof body.defaultDiffMode !== "string" ||
      !validDiffModes.includes(body.defaultDiffMode)
    ) {
      return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
    }
    updates.defaultDiffMode = body.defaultDiffMode;
  }

  if (body.defaultModelId !== undefined) {
    if (typeof body.defaultModelId !== "string") {
      return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
    }
    updates.defaultModelId = body.defaultModelId;
  }

  if (
    body.autoCommitLocal !== undefined &&
    typeof body.autoCommitLocal !== "boolean"
  ) {
    return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
  }
  if (body.autoCommitLocal !== undefined) {
    updates.autoCommitLocal = body.autoCommitLocal;
  }

  if (
    body.autoCommitPush !== undefined &&
    typeof body.autoCommitPush !== "boolean"
  ) {
    return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
  }
  if (body.autoCommitPush !== undefined) {
    updates.autoCommitPush = body.autoCommitPush;
  }

  if (
    body.autoCreatePr !== undefined &&
    typeof body.autoCreatePr !== "boolean"
  ) {
    return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
  }
  if (body.autoCreatePr !== undefined) {
    updates.autoCreatePr = body.autoCreatePr;
  }

  if (
    body.alertsEnabled !== undefined &&
    typeof body.alertsEnabled !== "boolean"
  ) {
    return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
  }
  if (body.alertsEnabled !== undefined) {
    updates.alertsEnabled = body.alertsEnabled;
  }

  if (
    body.alertSoundEnabled !== undefined &&
    typeof body.alertSoundEnabled !== "boolean"
  ) {
    return Response.json({ error: PREFERENCE_NOT_SAVED }, { status: 400 });
  }
  if (body.alertSoundEnabled !== undefined) {
    updates.alertSoundEnabled = body.alertSoundEnabled;
  }

  try {
    const preferences = await updateUserPreferences(session.user.id, updates);
    return Response.json({ preferences });
  } catch (error) {
    console.error("Failed to update preferences:", error);
    return Response.json(
      {
        error: "We couldn't save that setting. Try again in a moment.",
      },
      { status: 500 },
    );
  }
}
