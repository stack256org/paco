import type { SandboxState, SkillMetadata } from "@paco/sandbox";

/**
 * Cache of the skills discovered inside a sandbox.
 *
 * Discovery shells into the container and reads every `SKILL.md` it finds, so
 * it is far too slow to repeat on each chat turn — but the answer only changes
 * when the workspace does, which makes it a good fit for a short TTL.
 *
 * Held in process memory. This used to go through Redis with a memory cache in
 * front of it, which meant serialising to JSON, re-validating the shape on the
 * way back out, and a fallback path for every failure mode — around 200 lines
 * to avoid recomputing something that is already cheap to recompute. Paco runs
 * as one process, so the map in front was doing the real work and Redis was
 * only adding ways to fail. A cold start rediscovers, which costs one call.
 *
 * On `globalThis` so a Turbopack rebuild in development does not silently drop
 * the cache on every edit.
 */

/** Long enough to span a working session; short enough that adding a skill shows up. */
const TTL_MS = 4 * 60 * 60 * 1000;

type Entry = {
  skills: SkillMetadata[];
  expiresAt: number;
};

const globalForSkills = globalThis as typeof globalThis & {
  __pacoSkillsCache?: Map<string, Entry>;
};

function cache(): Map<string, Entry> {
  globalForSkills.__pacoSkillsCache ??= new Map<string, Entry>();
  return globalForSkills.__pacoSkillsCache;
}

/**
 * Scope the cache to the sandbox, not just the session.
 *
 * A session that hibernates and comes back gets a new container, and skills
 * installed in the old one are gone — keying on the session alone would serve
 * a list of skills that no longer exist.
 */
function cacheKey(
  sessionId: string,
  sandboxState: SandboxState | null | undefined,
): string {
  const scope =
    sandboxState && "sandboxName" in sandboxState && sandboxState.sandboxName
      ? sandboxState.sandboxName
      : "local";

  return `${sessionId}:${scope}`;
}

function sweep(now: number): void {
  for (const [key, entry] of cache()) {
    if (entry.expiresAt <= now) {
      cache().delete(key);
    }
  }
}

export function getCachedSkills(
  sessionId: string,
  sandboxState: SandboxState | null | undefined,
): SkillMetadata[] | null {
  const now = Date.now();
  sweep(now);

  const entry = cache().get(cacheKey(sessionId, sandboxState));
  return entry && entry.expiresAt > now ? entry.skills : null;
}

export function setCachedSkills(
  sessionId: string,
  sandboxState: SandboxState | null | undefined,
  skills: SkillMetadata[],
): void {
  cache().set(cacheKey(sessionId, sandboxState), {
    skills,
    expiresAt: Date.now() + TTL_MS,
  });
}
