import { describe, expect, mock, test } from "bun:test";
// Used only to identify which column a fake `eq`/`isNull`/`gt` call refers
// to (see below) — it is a pure schema definition with no side effects, so
// importing it here does not touch a database.
import { invitations } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

let rows: Row[] = [];
let members: Row[] = [];

/**
 * `acceptInvitation` is the security-critical function in this module: it is
 * what makes an invitation link work exactly once. Its WHERE clause
 * (token matches, not yet accepted, not expired) is the whole mechanism, so
 * the fake below has to actually evaluate it rather than approximate it —
 * a fake that ignores the clause and just grabs "the first unaccepted row"
 * would let every one of the tests below pass against an implementation
 * that accepts *any* token, which is worse than not testing it at all.
 *
 * Real drizzle-orm's `eq`/`and`/`isNull`/`gt` build an opaque SQL AST that
 * only a real database can execute. Rather than parse that (an internal,
 * version-fragile representation), this file replaces those four functions
 * with ones that build plain JS predicates over the fake `rows`/`members`
 * arrays — using the actual schema's column objects (imported above) as
 * identity keys, so `eq(invitations.token, token)` really does mean "the
 * row whose token equals this one" and nothing else.
 */
const COLUMN_KEYS = new Map<unknown, string>([
  [invitations.id, "id"],
  [invitations.organizationId, "organizationId"],
  [invitations.email, "email"],
  [invitations.role, "role"],
  [invitations.token, "token"],
  [invitations.invitedBy, "invitedBy"],
  [invitations.expiresAt, "expiresAt"],
  [invitations.acceptedAt, "acceptedAt"],
  [invitations.createdAt, "createdAt"],
]);

function keyFor(column: unknown): string {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

type Order = { column: unknown; direction: "asc" | "desc" };

const actualDrizzle = await import("drizzle-orm");

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  isNull:
    (column: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === null || row[keyFor(column)] === undefined,
  gt:
    (column: unknown, value: Date): Predicate =>
    (row) => {
      const actual = row[keyFor(column)];
      return actual instanceof Date && actual.getTime() > value.getTime();
    },
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  desc: (column: unknown): Order => ({ column, direction: "desc" }),
}));

type QueryResult = Promise<Row[]> & {
  limit(n: number): QueryResult;
  orderBy(order: Order): QueryResult;
  where(predicate: Predicate): QueryResult;
};

/**
 * A minimal stand-in for drizzle's chainable query builder.
 *
 * `findLiveInvitationByEmail` chains `.where(...).orderBy(...)`, so — unlike
 * the version of this fake that predated the `ORDER BY` fix — `where` can no
 * longer just be an async function that resolves immediately: it has to
 * return something `.orderBy`/`.limit` can still be called on, and the whole
 * thing has to be awaitable at any point in the chain, because production
 * code awaits after different numbers of links depending on the query.
 *
 * Built on a real `Promise` (with the chain methods attached to it) rather
 * than a plain object carrying its own `then`, so `await` resolves it through
 * `Promise.prototype.then` like any other awaited value, instead of this fake
 * having to reimplement thenable semantics.
 */
function makeQueryBuilder(currentRows: Row[]): QueryResult {
  const promise = Promise.resolve(currentRows) as QueryResult;
  promise.where = (predicate) =>
    makeQueryBuilder(currentRows.filter(predicate));
  promise.orderBy = (order) => {
    const key = keyFor(order.column);
    const sorted = [...currentRows].sort((a, b) => {
      const aValue = a[key];
      const bValue = b[key];
      const diff =
        aValue instanceof Date && bValue instanceof Date
          ? aValue.getTime() - bValue.getTime()
          : 0;
      return order.direction === "desc" ? -diff : diff;
    });
    return makeQueryBuilder(sorted);
  };
  promise.limit = (n) => makeQueryBuilder(currentRows.slice(0, n));
  return promise;
}

const fakeDb = {
  select: () => ({
    from: () => makeQueryBuilder(rows),
  }),
  insert: () => ({
    values: (values: Row) => ({
      returning: async () => {
        rows.push(values);
        return [values];
      },
      onConflictDoNothing: async () => {
        members.push(values);
      },
      onConflictDoUpdate: async ({ set }: { set: Row }) => {
        const existing = members.find(
          (member) =>
            member.organizationId === values.organizationId &&
            member.userId === values.userId,
        );
        if (existing) {
          Object.assign(existing, set);
        } else {
          members.push(values);
        }
      },
    }),
  }),
  update: () => ({
    set: (values: Row) => ({
      where: (predicate: Predicate) => ({
        returning: async () => {
          const target = rows.find(predicate);
          if (!target) {
            return [];
          }
          Object.assign(target, values);
          return [target];
        },
      }),
    }),
  }),
  delete: () => ({
    where: async (predicate: Predicate) => {
      rows = rows.filter((row) => !predicate(row));
    },
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));
mock.module("./organization", () => ({
  getOrganization: async () => ({
    id: "org-1",
    name: "Acme",
    createdAt: new Date(),
  }),
}));

const modulePromise = import("./invitations");

function liveRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "i1",
    organizationId: "org-1",
    email: "a@b.com",
    role: "member",
    token: "t",
    invitedBy: "user-0",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 100_000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("invitations", () => {
  test("an invitation carries a token, and the returned record does not", async () => {
    rows = [];
    members = [];
    const { createInvitation } = await modulePromise;

    const { token, invitation } = await createInvitation({
      email: "someone@example.com",
      role: "member",
      invitedBy: "user-1",
    });

    expect(token.length).toBeGreaterThan(20);
    expect(invitation.email).toBe("someone@example.com");
    expect(invitation).not.toHaveProperty("token");
  });

  test("re-inviting the same address supersedes the earlier invitation — only the newer role survives", async () => {
    // Failure this reproduces: an admin invites bob as Member, then
    // re-invites as Admin. Before the fix, both rows stayed live and
    // `findLiveInvitationByEmail` had no `ORDER BY`, so which role won was
    // whatever Postgres's planner happened to return first.
    rows = [];
    members = [];
    const { createInvitation, findLiveInvitationByEmail } = await modulePromise;

    await createInvitation({
      email: "bob@corp.com",
      role: "member",
      invitedBy: "admin-1",
    });
    const second = await createInvitation({
      email: "bob@corp.com",
      role: "admin",
      invitedBy: "admin-1",
    });

    expect(rows.length).toBe(1);
    const live = await findLiveInvitationByEmail("bob@corp.com");
    expect(live?.role).toBe("admin");
    expect(live?.token).toBe(second.token);
  });

  test("a double-submitted invite leaves only one live row, so revoking it actually withdraws access", async () => {
    // Failure this reproduces: an admin double-clicks Invite, sees two
    // identical pending rows, revokes the one they can see, and believes
    // access is withdrawn — but the other row still admits the invitee.
    rows = [];
    members = [];
    const { createInvitation, listPendingInvitations, revokeInvitation } =
      await modulePromise;

    await createInvitation({
      email: "double@corp.com",
      role: "member",
      invitedBy: "admin-1",
    });
    await createInvitation({
      email: "double@corp.com",
      role: "member",
      invitedBy: "admin-1",
    });

    const pending = await listPendingInvitations();
    expect(pending.length).toBe(1);

    const only = pending[0];
    if (!only) {
      throw new Error("expected exactly one pending invitation");
    }
    await revokeInvitation(only.id);

    expect(rows.length).toBe(0);
  });

  test("findLiveInvitationByEmail returns the most recently created row when more than one is live", async () => {
    // Covers data that predates the `createInvitation` supersede guarantee
    // (a restored backup, a row from before this fix shipped) — the ORDER BY
    // must not depend on insertion order or planner behaviour.
    rows = [
      liveRow({
        id: "older",
        email: "c@d.com",
        role: "member",
        token: "tok-older",
        createdAt: new Date(Date.now() - 60_000),
      }),
      liveRow({
        id: "newer",
        email: "c@d.com",
        role: "admin",
        token: "tok-newer",
        createdAt: new Date(),
      }),
    ];
    members = [];
    const { findLiveInvitationByEmail } = await modulePromise;

    const live = await findLiveInvitationByEmail("c@d.com");
    expect(live?.id).toBe("newer");
    expect(live?.role).toBe("admin");
  });

  test("an expired invitation is not live", async () => {
    rows = [
      liveRow({
        id: "i1",
        email: "a@b.com",
        token: "t",
        expiresAt: new Date(Date.now() - 1000),
      }),
    ];
    members = [];
    const { findLiveInvitationByEmail } = await modulePromise;

    expect(await findLiveInvitationByEmail("a@b.com")).toBeNull();
  });

  test("an accepted invitation is not live", async () => {
    rows = [
      liveRow({
        id: "i1",
        email: "a@b.com",
        token: "t",
        acceptedAt: new Date(),
      }),
    ];
    members = [];
    const { findLiveInvitationByEmail } = await modulePromise;

    expect(await findLiveInvitationByEmail("a@b.com")).toBeNull();
  });
});

describe("findLiveInvitationEmailByToken", () => {
  test("resolves a live token to its invited address, and nothing else", async () => {
    rows = [
      liveRow({
        id: "i1",
        email: "invited@corp.com",
        role: "admin",
        token: "tok-live",
      }),
    ];
    members = [];
    const { findLiveInvitationEmailByToken } = await modulePromise;

    expect(await findLiveInvitationEmailByToken("tok-live")).toBe(
      "invited@corp.com",
    );
  });

  test("an unknown token resolves to null, not an error", async () => {
    rows = [];
    members = [];
    const { findLiveInvitationEmailByToken } = await modulePromise;

    expect(
      await findLiveInvitationEmailByToken("tok-does-not-exist"),
    ).toBeNull();
  });

  test("an expired token resolves to null", async () => {
    rows = [
      liveRow({
        id: "i1",
        email: "a@b.com",
        token: "tok-expired",
        expiresAt: new Date(Date.now() - 1000),
      }),
    ];
    members = [];
    const { findLiveInvitationEmailByToken } = await modulePromise;

    expect(await findLiveInvitationEmailByToken("tok-expired")).toBeNull();
  });

  test("an already-accepted token resolves to null", async () => {
    rows = [
      liveRow({
        id: "i1",
        email: "a@b.com",
        token: "tok-used",
        acceptedAt: new Date(),
      }),
    ];
    members = [];
    const { findLiveInvitationEmailByToken } = await modulePromise;

    expect(await findLiveInvitationEmailByToken("tok-used")).toBeNull();
  });
});

describe("acceptInvitation", () => {
  test("a live token is accepted once, and a second use returns false", async () => {
    rows = [liveRow({ id: "i1", email: "a@b.com", token: "tok-live" })];
    members = [];
    const { acceptInvitation, findLiveInvitationByEmail } = await modulePromise;

    expect(await acceptInvitation("tok-live", "user-1")).toBe(true);
    // A forwarded link must not work a second time.
    expect(await acceptInvitation("tok-live", "user-2")).toBe(false);
    expect(await findLiveInvitationByEmail("a@b.com")).toBeNull();
  });

  test("an unknown token returns false, and does not throw", async () => {
    rows = [];
    members = [];
    const { acceptInvitation } = await modulePromise;

    let result: boolean | undefined;
    let thrown: unknown;
    try {
      result = await acceptInvitation("no-such-token", "user-1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(false);
  });

  test("an expired token returns false", async () => {
    rows = [
      liveRow({
        id: "i2",
        email: "c@d.com",
        token: "tok-expired",
        expiresAt: new Date(Date.now() - 1000),
      }),
    ];
    members = [];
    const { acceptInvitation } = await modulePromise;

    expect(await acceptInvitation("tok-expired", "user-1")).toBe(false);
  });

  test("an already-accepted token returns false", async () => {
    rows = [
      liveRow({
        id: "i3",
        email: "e@f.com",
        token: "tok-used",
        acceptedAt: new Date(),
      }),
    ];
    members = [];
    const { acceptInvitation } = await modulePromise;

    expect(await acceptInvitation("tok-used", "user-1")).toBe(false);
  });

  test("unknown, expired and already-accepted tokens are indistinguishable: all return the same false", async () => {
    const now = Date.now();
    rows = [
      liveRow({
        id: "i-expired",
        email: "x1@example.com",
        token: "tok-expired-2",
        expiresAt: new Date(now - 1000),
      }),
      liveRow({
        id: "i-used",
        email: "x2@example.com",
        token: "tok-used-2",
        acceptedAt: new Date(),
      }),
    ];
    members = [];
    const { acceptInvitation } = await modulePromise;

    const unknown = await acceptInvitation("tok-does-not-exist", "user-1");
    const expired = await acceptInvitation("tok-expired-2", "user-1");
    const used = await acceptInvitation("tok-used-2", "user-1");

    expect(unknown).toBe(false);
    expect(expired).toBe(false);
    expect(used).toBe(false);
    // Explicitly: not merely "all falsy", but the identical `false` value,
    // with nothing (an error, a distinguishing payload) that would let a
    // caller tell these three cases apart.
    expect(new Set([unknown, expired, used])).toEqual(new Set([false]));
  });

  test("a successful accept adds the membership with the invitation's role, not a default", async () => {
    rows = [
      liveRow({
        id: "i4",
        email: "admin-invite@example.com",
        role: "admin",
        token: "tok-admin",
      }),
    ];
    members = [];
    const { acceptInvitation } = await modulePromise;

    expect(await acceptInvitation("tok-admin", "user-9")).toBe(true);
    expect(members.length).toBe(1);
    expect(members[0]?.role).toBe("admin");
    expect(members[0]?.userId).toBe("user-9");
    expect(members[0]?.organizationId).toBe("org-1");
  });

  test("two invitations are simultaneously live: accepting one by token consumes only that one", async () => {
    // Both rows are valid right now — unlike the "indistinguishable" test
    // above, where every row is already invalid and would fail to match
    // with or without the token filter. This is the case that actually
    // proves `acceptInvitation` is selecting by *token*, not just "any live
    // row": if the WHERE clause dropped `eq(invitations.token, token)`, the
    // remaining filters (unaccepted, unexpired) would still match both A and
    // B.
    //
    // B is listed first deliberately. The fake's WHERE evaluates predicates
    // in array order and takes the first match, so a token-blind
    // implementation would silently grab B (the first live row) even when
    // asked to accept A's token — this ordering is what makes that failure
    // mode show up instead of accidentally matching by position.
    rows = [
      liveRow({
        id: "iB",
        email: "b@example.com",
        role: "admin",
        token: "tok-B",
      }),
      liveRow({
        id: "iA",
        email: "a@example.com",
        role: "member",
        token: "tok-A",
      }),
    ];
    members = [];
    const { acceptInvitation, findLiveInvitationByEmail } = await modulePromise;

    expect(await acceptInvitation("tok-A", "user-a")).toBe(true);

    // B's invitation is untouched: still live, still pending, still B's.
    const stillLiveB = await findLiveInvitationByEmail("b@example.com");
    expect(stillLiveB).not.toBeNull();
    expect(stillLiveB?.token).toBe("tok-B");
    expect(stillLiveB?.acceptedAt).toBeNull();

    // A is consumed and no longer live.
    expect(await findLiveInvitationByEmail("a@example.com")).toBeNull();

    // Only A's email gained a membership — B's holder never accepted.
    expect(members.length).toBe(1);
    expect(members[0]?.userId).toBe("user-a");
    expect(members[0]?.organizationId).toBe("org-1");
    expect(members[0]?.role).toBe("member");
  });

  test("accepting a later invitation upgrades an existing membership's role instead of leaving it unchanged", async () => {
    rows = [
      liveRow({
        id: "i5",
        email: "promoted@example.com",
        role: "admin",
        token: "tok-promote",
      }),
    ];
    // Already a member from an earlier invitation.
    members = [
      {
        organizationId: "org-1",
        userId: "user-5",
        role: "member",
        createdAt: new Date(),
      },
    ];
    const { acceptInvitation } = await modulePromise;

    expect(await acceptInvitation("tok-promote", "user-5")).toBe(true);
    expect(members.length).toBe(1);
    expect(members[0]?.role).toBe("admin");
  });
});
