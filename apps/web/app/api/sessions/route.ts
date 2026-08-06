import { nanoid } from "nanoid";
import { schedulePullRequestRefresh } from "./_lib/schedule-pr-refresh";
import {
  createSessionWithInitialChat,
  getArchivedSessionCountByUserId,
  getSessionsWithUnreadByUserId,
  getUsedSessionTitles,
} from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import {
  isValidGitHubRepoName,
  isValidGitHubRepoOwner,
  parseGitHubHttpsUrl,
} from "@/lib/github/urls";
import { getRandomCityName } from "@/lib/random-city";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { kickSandboxProvisioningWorkflow } from "@/lib/sandbox/provisioning-kick";
import { getServerSession } from "@/lib/session/get-server-session";
import { BAD_REQUEST, SIGNED_OUT } from "@/lib/error-copy";

const BAD_REPOSITORY =
  "That repository doesn't look right. Pick it from the list again.";

interface CreateSessionRequest {
  title?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  cloneUrl?: string;
  isNewBranch?: boolean;
  autoCommitPush?: boolean;
  autoCreatePr?: boolean;
}

function generateBranchName(username: string, name?: string | null): string {
  let initials = "nb";
  if (name) {
    initials =
      name
        .split(" ")
        .map((n) => n[0]?.toLowerCase() ?? "")
        .join("")
        .slice(0, 2) || "nb";
  } else if (username) {
    initials = username.slice(0, 2).toLowerCase();
  }
  const randomSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${initials}/${randomSuffix}`;
}

async function resolveSessionTitle(
  input: CreateSessionRequest,
  userId: string,
): Promise<string> {
  if (input.title && input.title.trim()) {
    return input.title.trim();
  }
  const usedNames = await getUsedSessionTitles(userId);
  return getRandomCityName(usedNames);
}

const DEFAULT_ARCHIVED_SESSIONS_LIMIT = 50;
const MAX_ARCHIVED_SESSIONS_LIMIT = 100;

type SessionsStatusFilter = "all" | "active" | "archived";

function parseNonNegativeInteger(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  if (!/^[0-9]+$/.test(value)) {
    return null;
  }

  return Number(value);
}

export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const rawStatus = searchParams.get("status");
  if (
    rawStatus !== null &&
    rawStatus !== "all" &&
    rawStatus !== "active" &&
    rawStatus !== "archived"
  ) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const statusParam: SessionsStatusFilter = rawStatus ?? "all";

  if (statusParam === "archived") {
    const rawLimit = parseNonNegativeInteger(searchParams.get("limit"));
    const rawOffset = parseNonNegativeInteger(searchParams.get("offset"));

    if (searchParams.get("limit") !== null && rawLimit === null) {
      return Response.json({ error: BAD_REQUEST }, { status: 400 });
    }

    if (searchParams.get("offset") !== null && rawOffset === null) {
      return Response.json({ error: BAD_REQUEST }, { status: 400 });
    }

    const limit = Math.min(
      Math.max(rawLimit ?? DEFAULT_ARCHIVED_SESSIONS_LIMIT, 1),
      MAX_ARCHIVED_SESSIONS_LIMIT,
    );
    const offset = rawOffset ?? 0;

    const [sessions, archivedCount] = await Promise.all([
      getSessionsWithUnreadByUserId(session.user.id, {
        status: "archived",
        limit,
        offset,
      }),
      getArchivedSessionCountByUserId(session.user.id),
    ]);

    return Response.json({
      sessions,
      archivedCount,
      pagination: {
        limit,
        offset,
        hasMore: offset + sessions.length < archivedCount,
        nextOffset: offset + sessions.length,
      },
    });
  }

  if (statusParam === "active") {
    const [sessions, archivedCount] = await Promise.all([
      getSessionsWithUnreadByUserId(session.user.id, {
        status: "active",
      }),
      getArchivedSessionCountByUserId(session.user.id),
    ]);

    // The sidebar already polls this endpoint, so it is the natural place to
    // keep pull-request state fresh. Runs after the response.
    schedulePullRequestRefresh(session.user.id);

    return Response.json({ sessions, archivedCount });
  }

  const sessions = await getSessionsWithUnreadByUserId(session.user.id);
  schedulePullRequestRefresh(session.user.id);
  return Response.json({ sessions });
}

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["sessions-create", session.user.id]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let body: CreateSessionRequest;
  try {
    body = (await req.json()) as CreateSessionRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  if (
    body.autoCommitPush !== undefined &&
    typeof body.autoCommitPush !== "boolean"
  ) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  if (
    body.autoCreatePr !== undefined &&
    typeof body.autoCreatePr !== "boolean"
  ) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  if (
    body.repoOwner !== undefined &&
    (typeof body.repoOwner !== "string" ||
      !isValidGitHubRepoOwner(body.repoOwner))
  ) {
    return Response.json({ error: BAD_REPOSITORY }, { status: 400 });
  }

  if (
    body.repoName !== undefined &&
    (typeof body.repoName !== "string" || !isValidGitHubRepoName(body.repoName))
  ) {
    return Response.json({ error: BAD_REPOSITORY }, { status: 400 });
  }

  if (body.cloneUrl !== undefined) {
    if (typeof body.cloneUrl !== "string") {
      return Response.json({ error: BAD_REPOSITORY }, { status: 400 });
    }

    const parsedCloneUrl = parseGitHubHttpsUrl(body.cloneUrl);
    if (
      !parsedCloneUrl ||
      parsedCloneUrl.owner !== body.repoOwner ||
      parsedCloneUrl.repo !== body.repoName
    ) {
      return Response.json({ error: BAD_REPOSITORY }, { status: 400 });
    }
  }

  const {
    repoOwner,
    repoName,
    branch,
    cloneUrl,
    isNewBranch,
    autoCommitPush,
    autoCreatePr,
  } = body;

  let finalBranch = branch;
  if (isNewBranch) {
    finalBranch = generateBranchName(session.user.username, session.user.name);
  }

  try {
    const titlePromise = resolveSessionTitle(body, session.user.id);
    const preferencesPromise = getUserPreferences(session.user.id);

    const [title, rawPreferences] = await Promise.all([
      titlePromise,
      preferencesPromise,
    ]);
    const preferences = rawPreferences;
    const effectiveAutoCommitPush =
      autoCommitPush ?? preferences.autoCommitPush;
    const effectiveAutoCreatePr = autoCreatePr ?? preferences.autoCreatePr;
    const result = await createSessionWithInitialChat({
      session: {
        id: nanoid(),
        userId: session.user.id,
        title,
        status: "running",
        repoOwner,
        repoName,
        branch: finalBranch,
        cloneUrl,
        isNewBranch: isNewBranch ?? false,
        autoCommitPushOverride: effectiveAutoCommitPush,
        autoCreatePrOverride: effectiveAutoCommitPush
          ? effectiveAutoCreatePr
          : false,
        sandboxState: { type: "docker" },
        lifecycleState: "provisioning",
        lifecycleVersion: 0,
      },
      initialChat: {
        id: nanoid(),
        title: "New chat",
        modelId: preferences.defaultModelId,
      },
    });

    await kickSandboxProvisioningWorkflow(result.session.id).catch((error) => {
      console.error(
        `Failed to kick sandbox provisioning for session ${result.session.id}:`,
        error,
      );
    });

    return Response.json(result);
  } catch (error) {
    console.error("Failed to create session:", error);
    return Response.json(
      { error: "We couldn't start that session. Try again." },
      { status: 500 },
    );
  }
}
