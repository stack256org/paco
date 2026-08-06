# Phase 2: Organization and Invite-Only Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One organisation per installation, created by the first person to arrive; everyone else gets in by invitation only. No public sign-up, no marketing site — signed out, Paco is a sign-in box.

**Architecture:** Two small tables (`organizations`, `organization_members`) rather than better-auth's organisation plugin, because only one organisation ever exists and the plugin's org-switching and slug machinery would be harder to walk back than tables we own. A third table (`invitations`) replaces the instance-wide `allow_new_users` toggle: `assertSignUpAllowed` changes from "first user, or the global switch is on" to "first user, or a live unaccepted invitation exists for this address". The first account is created and signed in directly, with no email round trip, because SMTP is not configured yet on a fresh install and telling an operator to read `docker logs` to reach their own instance is not acceptable.

**Tech Stack:** Next.js 16 (Turbopack), better-auth with the magic-link plugin, Drizzle ORM + Postgres, pg-boss, bun test, daisyUI.

## Global Constraints

- **Never use `any`** — use `unknown` and narrow with type guards.
- **No `.js` extensions** in imports.
- **Files** kebab-case; **types** PascalCase; **functions** camelCase.
- **Double quotes, 2-space indent**, enforced by `pnpm fix` (oxlint + oxfmt).
- **Zod** for validation; derive types with `z.infer`.
- **pnpm** for dependencies. **bun** for tests (`bun test <path>`).
- **After changing `lib/db/schema.ts`** run `pnpm --dir apps/web db:generate` and commit the generated `.sql`. Never `db:push`. Migrations are generated *and* must be applied locally with `pnpm --dir apps/web db:migrate:apply` before any UI that reads the new columns will work.
- **All UI work goes through the daisyUI Blueprint MCP** — `daisyui_setup_expert` (unique lowercase `workflowId`, absolute `projectRoot`), then the mandatory `daisyui_rules_enforcer`, then `daisyui_component_syntax_expert` before writing markup, then `daisyui_quality_inspector` with `auditIntent: "fix_changes"` and paths **relative to projectRoot**.
- **`pnpm run ci` runs ONCE**, at the end of the phase. While iterating use `pnpm typecheck` and `bun test <file>`.
- **Secrets and tokens never travel outward.** An invitation token is a credential: it is emailed, never listed in an API response.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/db/schema.ts` (modify) | `organizations`, `organizationMembers`, `invitations` tables; drop `allowNewUsers` |
| `apps/web/lib/org/organization.ts` (create) | Read the single organisation; create it with its owner |
| `apps/web/lib/org/organization.test.ts` (create) | Bootstrap is idempotent and race-safe |
| `apps/web/lib/org/membership.ts` (create) | Role lookup and role checks |
| `apps/web/lib/org/invitations.ts` (create) | Create, look up, accept, revoke, expire invitations |
| `apps/web/lib/org/invitations.test.ts` (create) | Token lifecycle, expiry, single use |
| `apps/web/lib/auth/signup-policy.ts` (modify) | Allow first user, or a live invitation; delete the toggle |
| `apps/web/lib/auth/bootstrap-admin.ts` (modify) | Also create the organisation and its owner membership |
| `apps/web/lib/auth/first-run.ts` (create) | "Has anyone ever signed up here?" — one source of truth |
| `apps/web/app/api/auth/first-run/route.ts` (create) | Public endpoint the sign-in page reads to decide its shape |
| `apps/web/lib/admin/invitation-actions.ts` (create) | Server actions: list, invite, revoke |
| `apps/web/app/settings/users/invite-section.tsx` (create) | Invite UI beside the existing user list |
| `apps/web/components/auth/sign-in-panel.tsx` (create) | The whole signed-out surface: sign in, or first-run registration |
| `apps/web/components/auth/signed-out-hero.tsx` (delete) | Replaced by the panel |
| `apps/web/components/landing/**` (delete) | No marketing site |
| `apps/web/app/settings/signup-access-section.tsx` (delete) | The toggle it drives is gone |

---

### Task 1: Organisation, membership and invitation tables

**Files:**
- Modify: `apps/web/lib/db/schema.ts`
- Create: a generated migration under `apps/web/lib/db/migrations/`

**Interfaces:**
- Consumes: the existing `users` table.
- Produces: `organizations`, `organizationMembers`, `invitations` Drizzle tables and their `$inferSelect` types. `instanceSettings.allowNewUsers` is **removed**.

- [ ] **Step 1: Add the tables**

In `apps/web/lib/db/schema.ts`, after the `users` table, add:

```ts
/**
 * The one organisation this installation serves.
 *
 * Paco is self-hosted: a VPS runs one company's Paco, so there is exactly one
 * row here and no organisation switcher anywhere in the product. It exists as
 * a table rather than an implicit fact because membership and invitations need
 * something to point at, and because "who is in this instance" is a different
 * question from "who has a row in users".
 */
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Who belongs to the organisation, and what they may do.
 *
 * `owner` is the person who installed Paco — there is exactly one, and it
 * cannot be given up, because an instance with no owner has no one who can
 * invite. `admin` may invite and manage settings; `member` may not.
 */
export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

/**
 * A pending invitation to join this instance.
 *
 * This is what replaced the instance-wide "anyone may create an account"
 * switch. The token is a credential — it is emailed and never returned by any
 * API — and an invitation is single-use: `acceptedAt` is what stops one link
 * being forwarded to a second person.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    /** Random, unguessable, and the only thing that proves the holder was invited. */
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("invitations_email_idx").on(table.email)],
);

export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
```

- [ ] **Step 2: Remove the instance-wide sign-up toggle**

Delete the `allowNewUsers` column and its doc comment from `instanceSettings`. Invitations replace it: an instance-wide "anyone may join" switch is exactly what this phase exists to remove.

- [ ] **Step 3: Generate and apply the migration**

Run: `pnpm --dir apps/web db:generate`
Expected: a new `.sql` creating three tables and dropping `instance_settings.allow_new_users`.

Run: `pnpm --dir apps/web db:migrate:apply`
Expected: applied without error. **This matters** — later tasks read these tables from a running app, and a generated-but-unapplied migration produces confusing SQL errors rather than an obvious failure.

Run: `pnpm --dir apps/web db:check`
Expected: `✓ Migrations are in sync with schema.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/lib/db/migrations
git commit -m "feat: add organisation, membership and invitation tables"
```

---

### Task 2: The organisation and its owner

**Files:**
- Create: `apps/web/lib/org/organization.ts`, `apps/web/lib/org/organization.test.ts`
- Create: `apps/web/lib/org/membership.ts`
- Modify: `apps/web/lib/auth/bootstrap-admin.ts`

**Interfaces:**
- Consumes: `organizations`, `organizationMembers` from `@/lib/db/schema`.
- Produces:
  - `getOrganization(): Promise<Organization | null>`
  - `ensureOrganizationWithOwner(userId: string, name?: string): Promise<Organization>` — idempotent; creates the organisation and makes `userId` its owner only if no organisation exists, otherwise returns the existing one untouched.
  - `getMemberRole(userId: string): Promise<"owner" | "admin" | "member" | null>`
  - `isOrganizationAdmin(userId: string): Promise<boolean>` — true for `owner` and `admin`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/org/organization.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;

let orgs: Row[] = [];
let members: Row[] = [];

const fakeDb = {
  select: () => ({
    from: (table: { _: { name?: string } } | unknown) => ({
      where: () => ({ limit: async () => orgs.slice(0, 1) }),
      limit: async () => orgs.slice(0, 1),
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: Row) => ({
      onConflictDoNothing: async () => {
        members.push(values);
      },
      returning: async () => {
        orgs.push(values);
        return [values];
      },
    }),
  }),
  transaction: async <T>(cb: (tx: typeof fakeDb) => Promise<T>) => cb(fakeDb),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const modulePromise = import("./organization");

describe("ensureOrganizationWithOwner", () => {
  test("creates the organisation and its owner on a fresh install", async () => {
    orgs = [];
    members = [];
    const { ensureOrganizationWithOwner } = await modulePromise;

    const org = await ensureOrganizationWithOwner("user-1", "Acme");

    expect(org.name).toBe("Acme");
    expect(orgs.length).toBe(1);
    expect(members.length).toBe(1);
    expect(members[0]?.role).toBe("owner");
  });

  test("is a no-op when an organisation already exists", async () => {
    orgs = [{ id: "org-1", name: "Existing", createdAt: new Date() }];
    members = [];
    const { ensureOrganizationWithOwner } = await modulePromise;

    const org = await ensureOrganizationWithOwner("user-2");

    expect(org.name).toBe("Existing");
    expect(orgs.length).toBe(1);
    // The second person must NOT become a second owner.
    expect(members.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/org/organization.test.ts`
Expected: FAIL — `Cannot find module './organization'`.

- [ ] **Step 3: Create `apps/web/lib/org/organization.ts`**

```ts
import "server-only";

import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type Organization,
  organizationMembers,
  organizations,
} from "@/lib/db/schema";

/**
 * The one organisation this installation serves.
 *
 * There is deliberately no "create organisation" screen. The organisation is
 * created as a side effect of the first person signing in, because a
 * self-hosted Paco serves exactly one company and asking them to name it
 * before they can use anything is a step with no decision in it.
 */

const DEFAULT_ORGANIZATION_NAME = "Paco";

export async function getOrganization(): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).limit(1);
  return row ?? null;
}

/**
 * Create the organisation and make this user its owner, once.
 *
 * Idempotent by design: it is called on every account creation, and only the
 * first call does anything. Two people signing in at the same moment must not
 * produce two organisations, so the existence check and the insert run in one
 * transaction and the membership insert tolerates a conflict.
 */
export async function ensureOrganizationWithOwner(
  userId: string,
  name?: string,
): Promise<Organization> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(organizations).limit(1);
    if (existing) {
      return existing;
    }

    const [created] = await tx
      .insert(organizations)
      .values({
        id: nanoid(),
        name: name?.trim() || DEFAULT_ORGANIZATION_NAME,
        createdAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create the organisation");
    }

    await tx
      .insert(organizationMembers)
      .values({
        organizationId: created.id,
        userId,
        role: "owner",
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    return created;
  });
}
```

- [ ] **Step 4: Create `apps/web/lib/org/membership.ts`**

```ts
import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { organizationMembers } from "@/lib/db/schema";
import { getOrganization } from "./organization";

/** What this user may do in the organisation, or `null` if they are not in it. */
export async function getMemberRole(
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const org = await getOrganization();
  if (!org) {
    return null;
  }

  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);

  return row?.role ?? null;
}

/**
 * Whether this user may invite people and change instance settings.
 *
 * Owner and admin are the same answer to that question; they differ only in
 * that an owner cannot be removed.
 */
export async function isOrganizationAdmin(userId: string): Promise<boolean> {
  const role = await getMemberRole(userId);
  return role === "owner" || role === "admin";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test apps/web/lib/org/organization.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Create the organisation alongside the first admin**

In `apps/web/lib/auth/bootstrap-admin.ts`, after `promoteFirstUserToAdmin` sets `isAdmin`, also call `ensureOrganizationWithOwner(userId)`. Keep the existing race-safe `NOT EXISTS` update exactly as it is — it is already correct and its comment explains why. Add the organisation call after it, and extend the file's doc comment to say the first account also becomes the organisation's owner.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/lib/org apps/web/lib/auth/bootstrap-admin.ts
git commit -m "feat: create the organisation and its owner on first sign-in"
```

---

### Task 3: Invitations

**Files:**
- Create: `apps/web/lib/org/invitations.ts`, `apps/web/lib/org/invitations.test.ts`

**Interfaces:**
- Consumes: `invitations` from `@/lib/db/schema`; `getOrganization` from `./organization`.
- Produces:
  - `type PendingInvitation = { id: string; email: string; role: "admin" | "member"; expiresAt: Date; createdAt: Date }` — **no token**.
  - `createInvitation(input: { email: string; role: "admin" | "member"; invitedBy: string }): Promise<{ token: string; invitation: PendingInvitation }>`
  - `findLiveInvitationByEmail(email: string): Promise<Invitation | null>` — unaccepted and unexpired only.
  - `acceptInvitation(token: string, userId: string): Promise<boolean>`
  - `listPendingInvitations(): Promise<PendingInvitation[]>`
  - `revokeInvitation(id: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/org/invitations.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let rows: Row[] = [];

const matches = (row: Row, now: Date) =>
  row.acceptedAt === null && (row.expiresAt as Date) > now;

const fakeDb = {
  select: () => ({
    from: () => ({
      where: async () => rows.filter((r) => matches(r, new Date())),
      limit: async () => rows.slice(0, 1),
      orderBy: async () => rows,
    }),
  }),
  insert: () => ({
    values: (values: Row) => ({
      returning: async () => {
        rows.push(values);
        return [values];
      },
    }),
  }),
  update: () => ({
    set: (values: Row) => ({
      where: () => ({
        returning: async () => {
          const target = rows.find((r) => r.acceptedAt === null);
          if (!target) return [];
          Object.assign(target, values);
          return [target];
        },
      }),
    }),
  }),
  delete: () => ({ where: async () => undefined }),
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

describe("invitations", () => {
  test("an invitation carries a token, and the returned record does not", async () => {
    rows = [];
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

  test("an expired invitation is not live", async () => {
    rows = [
      {
        id: "i1",
        email: "a@b.com",
        token: "t",
        acceptedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    const { findLiveInvitationByEmail } = await modulePromise;

    expect(await findLiveInvitationByEmail("a@b.com")).toBeNull();
  });

  test("an accepted invitation is not live", async () => {
    rows = [
      {
        id: "i1",
        email: "a@b.com",
        token: "t",
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 100_000),
      },
    ];
    const { findLiveInvitationByEmail } = await modulePromise;

    expect(await findLiveInvitationByEmail("a@b.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/org/invitations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/web/lib/org/invitations.ts`**

```ts
import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { type Invitation, invitations, organizationMembers } from "@/lib/db/schema";
import { getOrganization } from "./organization";

/**
 * Invitations are how anyone other than the first person gets in.
 *
 * The token is a bearer credential: whoever holds it can create an account on
 * this instance. So it is generated from `randomBytes`, never returned by any
 * listing, and single-use — `acceptedAt` is what stops a forwarded link
 * working twice.
 */

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
const EXPIRY_DAYS = 7;

export type PendingInvitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: Date;
  createdAt: Date;
};

function toPending(row: Invitation): PendingInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function createInvitation(input: {
  email: string;
  role: "admin" | "member";
  invitedBy: string;
}): Promise<{ token: string; invitation: PendingInvitation }> {
  const org = await getOrganization();
  if (!org) {
    throw new Error("There is no organisation to invite anyone to yet.");
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(invitations)
    .values({
      id: nanoid(),
      organizationId: org.id,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      token,
      invitedBy: input.invitedBy,
      expiresAt,
      acceptedAt: null,
      createdAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create the invitation");
  }

  return { token, invitation: toPending(row) };
}

/** An invitation that has not been used and has not run out of time. */
export async function findLiveInvitationByEmail(
  email: string,
): Promise<Invitation | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email.trim().toLowerCase()),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );

  return rows[0] ?? null;
}

/**
 * Mark an invitation used and put its holder in the organisation.
 *
 * Returns false when the token is unknown, already used, or expired — the
 * caller must treat all three the same, because telling them apart tells an
 * attacker which tokens exist.
 */
export async function acceptInvitation(
  token: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!row) {
    return false;
  }

  await db
    .insert(organizationMembers)
    .values({
      organizationId: row.organizationId,
      userId,
      role: row.role,
      createdAt: new Date(),
    })
    .onConflictDoNothing();

  return true;
}

export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt));

  return rows.map(toPending);
}

export async function revokeInvitation(id: string): Promise<void> {
  await db.delete(invitations).where(eq(invitations.id, id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/lib/org/invitations.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/org/invitations.ts apps/web/lib/org/invitations.test.ts
git commit -m "feat: create, look up and accept invitations"
```

---

### Task 4: Sign-up is first-user-or-invited

**Files:**
- Modify: `apps/web/lib/auth/signup-policy.ts`
- Create: `apps/web/lib/auth/first-run.ts`
- Modify: `apps/web/lib/admin/actions.ts` (drop the toggle actions)
- Delete: `apps/web/app/settings/signup-access-section.tsx`
- Modify: `apps/web/app/settings/admin/page.tsx` (stop rendering it)

**Interfaces:**
- Produces: `isFirstRun(): Promise<boolean>` from `@/lib/auth/first-run` — true when no account exists yet. `assertSignUpAllowed()` keeps its signature and its `APIError` behaviour.

- [ ] **Step 1: Write the failing test**

Extend `apps/web/lib/auth/signup-policy.test.ts` (create it if absent) with the four cases:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let userCount = 0;
let liveInvitation: { email: string } | null = null;

mock.module("@/lib/db/client", () => ({
  db: {
    select: () => ({ from: async () => [{ total: userCount }] }),
  },
}));
mock.module("@/lib/org/invitations", () => ({
  findLiveInvitationByEmail: async (email: string) =>
    liveInvitation && liveInvitation.email === email ? liveInvitation : null,
}));

const modulePromise = import("./signup-policy");

describe("assertSignUpAllowed", () => {
  test("the very first account is always allowed", async () => {
    userCount = 0;
    liveInvitation = null;
    const { assertSignUpAllowed } = await modulePromise;

    expect(assertSignUpAllowed("anyone@example.com")).resolves.toBeUndefined();
  });

  test("an invited address is allowed", async () => {
    userCount = 1;
    liveInvitation = { email: "invited@example.com" };
    const { assertSignUpAllowed } = await modulePromise;

    expect(
      assertSignUpAllowed("invited@example.com"),
    ).resolves.toBeUndefined();
  });

  test("an uninvited address is refused once an account exists", async () => {
    userCount = 1;
    liveInvitation = null;
    const { assertSignUpAllowed } = await modulePromise;

    expect(assertSignUpAllowed("stranger@example.com")).rejects.toThrow();
  });

  test("a different address than the invited one is refused", async () => {
    userCount = 1;
    liveInvitation = { email: "invited@example.com" };
    const { assertSignUpAllowed } = await modulePromise;

    expect(assertSignUpAllowed("someone-else@example.com")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/auth/signup-policy.test.ts`
Expected: FAIL — `assertSignUpAllowed` currently takes no argument and consults the removed toggle.

- [ ] **Step 3: Rewrite the policy**

Replace the body of `apps/web/lib/auth/signup-policy.ts`. Keep `SIGNUP_DISABLED_CODE` and the `APIError` shape exactly — better-auth only turns a thrown error into `?error=<code>` on the callback when it carries a status and a code, and anything else escapes as a blank 500 at the end of a magic link. Delete `readAllowNewUsers` and `setAllowNewUsers`. Move `isFirstUser` into the new `first-run.ts` as `isFirstRun` and re-export nothing from here that no longer exists.

`assertSignUpAllowed(email: string)` now returns without complaint when `isFirstRun()` is true, or when `findLiveInvitationByEmail(email)` returns a row; otherwise it throws the same `APIError("FORBIDDEN", …)` with a message saying this instance is invitation-only and to ask an administrator for an invitation.

- [ ] **Step 4: Pass the email through better-auth's hook**

In `apps/web/lib/auth/config.ts`, the `databaseHooks.user.create.before` hook receives the user being created. Pass its email into `assertSignUpAllowed(user.email)`. If the email is absent, refuse — an account with no address cannot have been invited.

- [ ] **Step 5: Delete the toggle**

Remove `getAllowNewUsers`/`updateAllowNewUsers` from `apps/web/lib/admin/actions.ts`, delete `apps/web/app/settings/signup-access-section.tsx`, and remove its import and `<SignupAccessSection />` from `apps/web/app/settings/admin/page.tsx`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm typecheck && bun test apps/web/lib/auth/`
Expected: clean; 4 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/auth apps/web/lib/admin/actions.ts apps/web/app/settings
git commit -m "feat: replace the sign-up toggle with invitations"
```

---

### Task 5: Accepting an invitation, and the first-run endpoint

**Files:**
- Create: `apps/web/app/api/auth/first-run/route.ts`
- Modify: `apps/web/lib/auth/config.ts` (accept the invitation after the account exists)

**Interfaces:**
- Produces: `GET /api/auth/first-run` → `{ firstRun: boolean }`, unauthenticated.

- [ ] **Step 1: Create the endpoint**

```ts
import { isFirstRun } from "@/lib/auth/first-run";

/**
 * Whether this installation has any account at all.
 *
 * Deliberately unauthenticated: the sign-in page has to know which of two
 * shapes to render before anyone has signed in, and the answer leaks nothing —
 * "nobody has claimed this instance" is obvious to anyone who can reach it and
 * see an empty sign-in form.
 */
export async function GET(): Promise<Response> {
  return Response.json({ firstRun: await isFirstRun() });
}
```

- [ ] **Step 2: Accept the invitation once the account exists**

In `apps/web/lib/auth/config.ts`'s `databaseHooks.user.create.after`, alongside `promoteFirstUserToAdmin(user.id)`, look up a live invitation for `user.email` and, if there is one, call `acceptInvitation(invitation.token, user.id)` so the new account lands in the organisation with the role it was invited as. Order matters: this runs *after* the row exists, which is what lets the membership foreign key resolve.

For the first user there is no invitation — `ensureOrganizationWithOwner` (Task 2) already made them the owner, so guard the accept on an invitation actually being found rather than assuming one.

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/app/api/auth/first-run apps/web/lib/auth/config.ts
git commit -m "feat: put an invited account into the organisation on sign-up"
```

---

### Task 6: Invite UI

**Files:**
- Create: `apps/web/lib/admin/invitation-actions.ts`
- Create: `apps/web/app/settings/users/invite-section.tsx`
- Modify: `apps/web/app/settings/users/page.tsx`

**Interfaces:**
- Produces server actions: `getPendingInvitations()`, `inviteMember(input: { email: string; role: "admin" | "member" })`, `revokeMemberInvitation(id: string)`. All admin-guarded, all returning `{ success: boolean; error?: string }` except the getter. **None returns a token.**

- [ ] **Step 1: Create the actions**

Follow the shape of `apps/web/lib/admin/instance-settings-actions.ts`: `"use server"`, `requireAdmin()` first in every action, Zod validation, and — because a `"use server"` module may only export async functions — put any schema in a sibling non-`"use server"` module if you need to test it directly.

`inviteMember` must:
1. `requireAdmin()`.
2. Validate the email.
3. Refuse if that address already has an account, with a message saying so.
4. Refuse if SMTP is not configured — call `resolveSmtpConfig()` from `@/lib/email/smtp-config` and return an error pointing at Settings. **Queueing mail nothing can deliver is the failure this check exists to prevent**: the invitation would look sent and never arrive.
5. Create the invitation, then enqueue the email through `enqueue(QUEUES.sendEmail, …)` exactly as `lib/auth/config.ts` does for magic links, with a link to `${appUrl()}/?invitation=<token>`.
6. Return `{ success: true }` — never the token.

Write the invitation email body in a new `apps/web/lib/email/invitation-email.ts` beside `buildMagicLinkEmail`, matching its shape and voice: who invited them, what Paco is in one line, the link, and when it expires.

- [ ] **Step 2: Build the UI**

Run the daisyUI MCP flow (`workflowId: "paco-invitations"`). The section shows: an email field, a role select (Member / Admin), an Invite button, and a table of pending invitations with their address, role, expiry and a Revoke action. Mount it in `apps/web/app/settings/users/page.tsx` above the existing user list.

Requirements the copy must satisfy:
- It states that an invitation is the only way for someone new to sign in.
- If SMTP is unconfigured, the form explains that and links to Settings rather than failing on submit.
- A revoked invitation disappears from the list immediately.

- [ ] **Step 3: Audit and verify**

Run `daisyui_quality_inspector` with `auditIntent: "fix_changes"` and the changed paths relative to projectRoot. Then check it in the browser against the running dev server on http://localhost:3066 (do not start another): invite an address, confirm it appears as pending, revoke it, confirm it disappears.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/admin/invitation-actions.ts apps/web/lib/email/invitation-email.ts apps/web/app/settings/users
git commit -m "feat: invite people to the organisation from settings"
```

---

### Task 7: Signed out, Paco is a sign-in box

**Files:**
- Create: `apps/web/components/auth/sign-in-panel.tsx`
- Delete: `apps/web/components/auth/signed-out-hero.tsx`
- Delete: `apps/web/components/landing/` (whole directory)
- Modify: `apps/web/app/home-page.tsx`, `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/first-run`; the existing `SignInButton` and `SignInErrorNotice` from `@/components/auth/`.
- Produces: `<SignInPanel />`, a client component taking no props.

- [ ] **Step 1: Build the panel**

Run the daisyUI MCP flow (`workflowId: "paco-sign-in"`). Two states, chosen by `GET /api/auth/first-run`:

- **First run** (no account exists): a short registration form — email, and an optional organisation name — with copy explaining this claims the instance and makes this account its owner. Submitting creates the account and signs them in **directly, with no email round trip**, because SMTP is not configured yet on a fresh install.
- **Every other time**: the existing magic-link sign-in. Keep `SignInErrorNotice` rendered *above* the control — an expired link is why someone is looking at this page again, and they need to read why before reaching for the button. Add a line saying this instance is invitation-only, so someone without an account understands why typing their address does nothing.

Keep it to a centred card. No hero, no feature grid, no footer, no marketing nav.

- [ ] **Step 2: Wire the first-run registration**

Add `POST /api/auth/first-run` to the route created in Task 5 — or a sibling route — that:
1. Refuses with 409 unless `isFirstRun()` is still true. **This is the whole security model of the endpoint**: it is unauthenticated and creates an owner account, so it must be unreachable the instant one account exists. Check inside the same request that creates the user, not before.
2. Creates the account through better-auth, which triggers the existing hooks (`assertSignUpAllowed` passes because it is the first run; `promoteFirstUserToAdmin` and `ensureOrganizationWithOwner` run after).
3. Establishes a session and returns success.

Use better-auth's server API for account creation and session creation rather than writing rows directly — the hooks and the session format must stay its business.

- [ ] **Step 3: Delete the marketing site**

```bash
git rm apps/web/components/auth/signed-out-hero.tsx
git rm -r apps/web/components/landing
```

Then fix every import that referred to them. `apps/web/app/home-page.tsx` renders `SignedOutHero`; point it at `SignInPanel`. Search for other importers before assuming there is one:

Run: `grep -rn "signed-out-hero\|components/landing" apps/web --include="*.tsx" --include="*.ts" | grep -v '/.next/'`
Expected after the fix: no output.

- [ ] **Step 4: Audit, verify, commit**

Run `daisyui_quality_inspector` with `auditIntent: "fix_changes"`. Check in the browser: signed out, `/` shows only the sign-in card. Then commit.

```bash
git add -A
git commit -m "feat: signed out, Paco is a sign-in box"
```

---

### Task 8: Phase close-out

- [ ] **Step 1: Confirm the toggle is gone everywhere**

Run: `grep -rn "allowNewUsers\|allow_new_users\|SignupAccessSection" apps packages --include="*.ts" --include="*.tsx" --include="*.sql" | grep -v node_modules | grep -v '/.next/' | grep -v migrations/`
Expected: no output outside the migration that drops it.

- [ ] **Step 2: Confirm no invitation token can leave the server**

Run: `grep -rn "token" apps/web/lib/admin/invitation-actions.ts apps/web/app/settings/users/*.tsx`
Expected: no occurrence that puts a token into a response or into rendered output. Read the results; do not just count them.

- [ ] **Step 3: Run the full checks, once**

Run: `pnpm run ci`
Expected: format, lint, typecheck, the full suite, and `✓ Migrations are in sync with schema.ts`.

- [ ] **Step 4: Commit any formatting**

```bash
pnpm fix
git add -A
git commit -m "chore: formatting after phase 2"
```

---

## Self-Review

**Spec coverage.** The spec's Phase 2 asks for: two tables not the plugin (Task 1), sessions staying user-owned with the organisation as the membership boundary (Tasks 1–2), invitations replacing `allow_new_users` (Tasks 3–4), the first run signing the admin in directly with no email round trip (Task 7), and the marketing surface deleted (Task 7). All covered.

**Deliberately deferred.** Roles are stored and enforced for invitation and settings access, but there is no role-management UI — changing someone's role is not something a one-organisation install needs on day one, and adding it would widen this phase without serving the goal. `getMemberRole` exists so a later phase can add it cheaply.

**Type consistency.** `PendingInvitation` (Task 3) is what `listPendingInvitations` returns and what Task 6's actions expose; it deliberately omits `token`, which is why Task 8 Step 2 greps for leaks. `assertSignUpAllowed(email: string)` gains a parameter in Task 4 and its only caller is updated in the same task.

**Known risk.** Task 7's `POST /api/auth/first-run` creates an owner account without authentication. Its guard is that `isFirstRun()` must still be true, checked inside the request. If that check were ever removed or evaluated too early, the endpoint would let anyone claim an owner account on a running instance. It is called out here so the reviewer treats it as the security-critical line it is.
