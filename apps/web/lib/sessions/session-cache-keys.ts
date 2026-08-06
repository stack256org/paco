/**
 * The SWR keys the two workspace lists are cached under.
 *
 * Named here because deleting a workspace has to reach both of them from
 * outside either hook: the row leaves the archived list, and the live list owns
 * the "Archived (3)" count that has just become a 2. A key spelled out at each
 * call site is a cache entry nobody updates the day one of them changes.
 */

/**
 * Live workspaces, plus the archived count shown on the switcher's section.
 *
 * The query string is part of the key, and that is the whole point. `useSessions`
 * used to cache under a bare `"/api/sessions"` while fetching whichever URL its
 * `includeArchived` option implied — so the home page (every status, and no
 * `archivedCount` in the response) and the workspace switcher (active only)
 * shared one cache entry describing different things. Navigating from the home
 * page into a workspace handed the switcher archived rows and an undefined
 * count. A key that does not name the request it stands for is not a key.
 */
export const ACTIVE_SESSIONS_KEY = "/api/sessions?status=active";

/**
 * Every workspace regardless of status, as the home page lists them.
 *
 * Deliberately a different entry from `ACTIVE_SESSIONS_KEY`: the responses have
 * different rows *and* a different shape, so one cannot stand in for the other.
 */
export const ALL_SESSIONS_KEY = "/api/sessions";

/** The archived list itself, fetched only when that section is opened. */
export const ARCHIVED_SESSIONS_KEY = "/api/sessions?status=archived";
