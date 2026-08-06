# Phase 1: Runtime Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public origin and SMTP credentials runtime configuration rather than build-time constants, so one public image can serve every installation and an operator can set their domain and mail server from inside the product.

**Architecture:** `NEXT_PUBLIC_APP_URL` is renamed to `APP_URL`, which removes Turbopack's build-time inlining and makes it a genuine runtime lookup. Domain and SMTP settings move into the existing one-row `instance_settings` table, with the SMTP password sealed by the same `secret-box` used for GitHub tokens. SMTP is read at send time, so it applies immediately. The domain must be present at process start for better-auth's `allowedHosts`, so `docker-entrypoint.sh` reads it from the database and exports `APP_URL` before starting the server — a restart is all that is needed, and application code keeps one resolution path.

**Tech Stack:** Next.js 16 (Turbopack), better-auth, Drizzle ORM + Postgres, nodemailer, pg-boss, bun test, daisyUI.

## Global Constraints

- **Never use `any`** — use `unknown` and narrow with type guards.
- **No `.js` extensions** in imports.
- **Files** kebab-case; **types** PascalCase; **functions** camelCase.
- **Formatting** double quotes, 2-space indent, enforced by `pnpm fix` (oxlint + oxfmt).
- **Zod** for validation; derive types with `z.infer`.
- **pnpm only** for dependencies. Bun for tests.
- **After changing `lib/db/schema.ts`** run `pnpm --dir apps/web db:generate` and commit the generated `.sql`. Never `db:push`.
- **Any UI work goes through the daisyUI Blueprint MCP** — `daisyui_setup_expert` with a unique lowercase `workflowId` and absolute `projectRoot`, then the mandatory `daisyui_rules_enforcer`, then `daisyui_component_syntax_expert` before writing markup. Hand-written Tailwind drifts from the design tokens.
- **`pnpm run ci` runs ONCE, at the very end of the phase** — not per task. While iterating use `bun test <file>` and `pnpm typecheck`.
- **Secrets never travel outward.** The SMTP password is written to the database sealed and is never included in any API or server-action response.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/app-url.ts` (modify) | Synchronous public origin from `APP_URL`, with a localhost default |
| `apps/web/lib/app-url.test.ts` (modify) | Resolution order incl. the new default |
| `apps/web/lib/db/schema.ts` (modify) | New `instance_settings` columns |
| `apps/web/lib/settings/instance-settings.ts` (create) | Read/write the one settings row; seals the SMTP password |
| `apps/web/lib/settings/instance-settings.test.ts` (create) | Defaults, round-trip, sealing |
| `apps/web/lib/email/smtp-config.ts` (create) | Resolve effective SMTP config: database, then environment |
| `apps/web/lib/email/smtp-config.test.ts` (create) | Precedence and "is it configured" |
| `apps/web/lib/email/mailer.ts` (modify) | Build the transport from resolved config rather than `process.env` |
| `apps/web/lib/admin/instance-settings-actions.ts` (create) | Server actions: read, save domain, save SMTP, send test email |
| `apps/web/app/settings/admin/domain-section.tsx` (create) | Domain UI + restart affordance |
| `apps/web/app/settings/admin/smtp-section.tsx` (create) | SMTP UI + test-email button |
| `apps/web/app/settings/admin/page.tsx` (modify) | Mount the two new sections |
| `apps/web/app/api/admin/restart/route.ts` (create) | Restart the container through the mounted Docker socket |
| `docker-entrypoint.sh` (modify) | Export `APP_URL` from the database when not set |
| `Dockerfile` (modify) | Delete the `ARG`/`ENV NEXT_PUBLIC_APP_URL` pair |
| `docker-compose.yml` (modify) | Delete the build arg; pass `APP_URL` at runtime |

---

### Task 1: `APP_URL` becomes a runtime variable

**Files:**
- Modify: `apps/web/lib/app-url.ts`
- Modify: `apps/web/lib/app-url.test.ts`
- Modify: `apps/web/scripts/dev.ts`
- Modify: `apps/web/.env`, `apps/web/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `appUrl(): URL` and `appHost(): string` from `@/lib/app-url`, unchanged signatures, now reading `process.env.APP_URL` and falling back to `http://localhost:${process.env.PORT ?? "3000"}`.

- [ ] **Step 1: Write the failing test**

Replace the body of `apps/web/lib/app-url.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appHost, appUrl } from "./app-url";

const originalUrl = process.env.APP_URL;
const originalPort = process.env.PORT;

beforeEach(() => {
  delete process.env.APP_URL;
  delete process.env.PORT;
});

afterEach(() => {
  process.env.APP_URL = originalUrl;
  process.env.PORT = originalPort;
});

describe("appUrl", () => {
  test("uses APP_URL when set", () => {
    process.env.APP_URL = "https://paco.example.com";
    expect(appUrl().origin).toBe("https://paco.example.com");
    expect(appHost()).toBe("paco.example.com");
  });

  test("falls back to localhost on the default port", () => {
    expect(appUrl().origin).toBe("http://localhost:3000");
  });

  test("honours PORT in the fallback", () => {
    process.env.PORT = "3066";
    expect(appUrl().origin).toBe("http://localhost:3066");
  });

  test("rejects a URL with no scheme", () => {
    process.env.APP_URL = "localhost:3066";
    expect(() => appUrl()).toThrow(/must be an http\(s\) URL with a host/);
  });

  test("rejects a URL that does not parse", () => {
    process.env.APP_URL = "not a url";
    expect(() => appUrl()).toThrow(/is not a valid URL/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/app-url.test.ts`
Expected: FAIL — the fallback tests throw "APP_URL is not set" because the current code has no default and still reads the old variable.

- [ ] **Step 3: Rewrite `apps/web/lib/app-url.ts`**

```ts
/**
 * The public origin this deployment is served on.
 *
 * `APP_URL` deliberately carries no `NEXT_PUBLIC_` prefix. Next inlines
 * `process.env.NEXT_PUBLIC_*` at build time — in server code as well as in the
 * browser bundle — so a prefixed variable would be frozen to whatever the image
 * was built with, and one published image could not serve two installations.
 * Nothing in the browser reads this value, so the prefix bought nothing and
 * cost runtime configurability.
 *
 * Unlike the previous version there *is* a fallback, because a fresh install
 * has no domain yet and must still be reachable. The fallback names localhost,
 * which is only ever right for the machine the operator is on — it cannot be
 * mistaken for a working public origin the way a stale baked-in domain could.
 *
 * A domain configured in Settings does not appear here. `docker-entrypoint.sh`
 * reads it from the database and exports `APP_URL` before the server starts,
 * so there is one resolution path rather than two.
 */
const DEFAULT_PORT = "3000";

export function appUrl(): URL {
  const value = process.env.APP_URL?.trim();
  const raw = value || `http://localhost:${process.env.PORT?.trim() || DEFAULT_PORT}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `APP_URL is not a valid URL: ${raw}. Include the scheme and, unless it is the default for that scheme, the port.`,
    );
  }

  // `new URL("localhost:3066")` succeeds — it reads as the scheme "localhost:"
  // with path "3066", and leaves `host` empty. Left unchecked that yields an
  // empty allowed origin, so every sign-in callback is rejected as untrusted
  // while the value looks correct in `.env`.
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
    throw new Error(
      `APP_URL must be an http(s) URL with a host: ${raw}. A missing scheme is the usual cause — "localhost:3066" parses as a scheme, not a host.`,
    );
  }

  return url;
}

/**
 * The origin's `host:port`, as better-auth matches trusted origins.
 *
 * `URL.host` keeps an explicit port and omits the default one for the scheme,
 * which is what a browser sends in the `Host` header — so `https://paco.example`
 * matches a request to that host, and a URL naming an explicit port only
 * matches that port.
 */
export function appHost(): string {
  return appUrl().host;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/lib/app-url.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Update the remaining references to the old name**

In `apps/web/scripts/dev.ts` replace every `NEXT_PUBLIC_APP_URL` with `APP_URL` (three error strings and one `process.env` read on line 23). The comment on line 2 becomes "Start the dev server on the port `APP_URL` names."

In `apps/web/.env` and `apps/web/.env.example`, rename the key:

```text
APP_URL=http://localhost:3066
```

Then confirm nothing is left:

Run: `grep -rn "NEXT_PUBLIC_APP_URL" apps packages --include="*.ts" --include="*.tsx" --include="*.example" | grep -v node_modules | grep -v '/.next/'`
Expected: only `apps/web/app/workflows/chat.test.ts` and `apps/web/app/workflows/chat.ts`, handled next.

- [ ] **Step 6: Update the two workflow references**

In `apps/web/app/workflows/chat.test.ts` line 12 change the seed to:

```ts
process.env.APP_URL ??= "http://localhost:3066";
```

In `apps/web/app/workflows/chat.ts` the reference is a comment on line 969; change `NEXT_PUBLIC_APP_URL` to `APP_URL` in the prose.

- [ ] **Step 7: Typecheck and run the affected tests**

Run: `pnpm typecheck && bun test apps/web/lib/app-url.test.ts apps/web/app/workflows/chat.test.ts`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/app-url.ts apps/web/lib/app-url.test.ts apps/web/scripts/dev.ts apps/web/.env apps/web/.env.example apps/web/app/workflows/chat.ts apps/web/app/workflows/chat.test.ts
git commit -m "feat: make the public origin a runtime variable"
```

---

### Task 2: `instance_settings` gains domain and SMTP columns

**Files:**
- Modify: `apps/web/lib/db/schema.ts:388-405`
- Create: `apps/web/lib/db/migrations/` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: columns on `instanceSettings` — `appDomain: text | null`, `tlsEnabled: boolean`, `previewBaseDomain: text | null`, `smtpHost: text | null`, `smtpPort: integer | null`, `smtpSecure: boolean | null`, `smtpUser: text | null`, `smtpPasswordSealed: text | null`, `smtpFrom: text | null`. Type `InstanceSettings` widens accordingly.

- [ ] **Step 1: Add the columns**

In `apps/web/lib/db/schema.ts`, inside the `instanceSettings` table and immediately before `updatedAt`, add:

```ts
  /**
   * The public origin this instance is served on, once an operator sets one.
   *
   * Null until then, which is the normal state of a fresh install: it is
   * reachable on the server's address and needs no domain to work. This is not
   * read by the application at request time — `docker-entrypoint.sh` exports it
   * as `APP_URL` at start-up, so the whole process agrees on one origin.
   */
  appDomain: text("app_domain"),
  /** Whether Traefik should request certificates for this instance's hosts. */
  tlsEnabled: boolean("tls_enabled").notNull().default(false),
  /** Parent domain for preview hostnames, e.g. "previews.example.com". */
  previewBaseDomain: text("preview_base_domain"),

  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSecure: boolean("smtp_secure"),
  smtpUser: text("smtp_user"),
  /**
   * Sealed with `lib/crypto/secret-box`, never hashed.
   *
   * nodemailer authenticates with the original on every send, so there is
   * nothing to compare a hash against. Sealed with the key derived from
   * `APP_SECRET`, exactly as GitHub tokens are — changing that secret makes
   * this unreadable and the operator re-enters it.
   */
  smtpPasswordSealed: text("smtp_password_sealed"),
  smtpFrom: text("smtp_from"),
```

`integer` must be added to the existing `drizzle-orm/pg-core` import at the top of the file if it is not already there.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --dir apps/web db:generate`
Expected: a new `.sql` under `apps/web/lib/db/migrations/` containing nine `ALTER TABLE "instance_settings" ADD COLUMN` statements.

- [ ] **Step 3: Verify schema and migrations agree**

Run: `pnpm --dir apps/web db:check`
Expected: `✓ Migrations are in sync with schema.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/lib/db/migrations
git commit -m "feat: add domain and SMTP columns to instance settings"
```

---

### Task 3: Reading and writing the settings row

**Files:**
- Create: `apps/web/lib/settings/instance-settings.ts`
- Create: `apps/web/lib/settings/instance-settings.test.ts`

**Interfaces:**
- Consumes: `instanceSettings` from `@/lib/db/schema`; `seal`/`open` from `@/lib/crypto/secret-box`.
- Produces:
  - `type SmtpSettingsInput = { host: string | null; port: number | null; secure: boolean | null; user: string | null; password: string | null; from: string | null }`
  - `type StoredSmtpSettings = Omit<SmtpSettingsInput, "password"> & { password: string | null }`
  - `readInstanceSettings(): Promise<InstanceSettingsView>` where `InstanceSettingsView = { appDomain: string | null; tlsEnabled: boolean; previewBaseDomain: string | null; smtp: StoredSmtpSettings }`
  - `saveAppDomain(input: { appDomain: string | null; tlsEnabled: boolean; previewBaseDomain: string | null }): Promise<void>`
  - `saveSmtpSettings(input: SmtpSettingsInput): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/settings/instance-settings.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";

process.env.APP_SECRET ??= "test-secret-for-sealing-values-0123456789";

type Row = Record<string, unknown>;

let stored: Row | null = null;

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (stored ? [stored] : []),
      }),
    }),
  }),
  insert: () => ({
    values: (values: Row) => ({
      onConflictDoUpdate: async ({ set }: { set: Row }) => {
        stored = { ...(stored ?? {}), ...values, ...set };
      },
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const modulePromise = import("./instance-settings");

describe("instance settings", () => {
  test("a fresh install reads as unconfigured", async () => {
    stored = null;
    const { readInstanceSettings } = await modulePromise;

    const settings = await readInstanceSettings();

    expect(settings.appDomain).toBeNull();
    expect(settings.tlsEnabled).toBe(false);
    expect(settings.smtp.host).toBeNull();
    expect(settings.smtp.password).toBeNull();
  });

  test("saving a domain round-trips", async () => {
    stored = null;
    const { readInstanceSettings, saveAppDomain } = await modulePromise;

    await saveAppDomain({
      appDomain: "https://paco.example.com",
      tlsEnabled: true,
      previewBaseDomain: "previews.example.com",
    });

    const settings = await readInstanceSettings();
    expect(settings.appDomain).toBe("https://paco.example.com");
    expect(settings.tlsEnabled).toBe(true);
    expect(settings.previewBaseDomain).toBe("previews.example.com");
  });

  test("the SMTP password is sealed at rest and readable back", async () => {
    stored = null;
    const { readInstanceSettings, saveSmtpSettings } = await modulePromise;

    await saveSmtpSettings({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "paco",
      password: "hunter2",
      from: "Paco <no-reply@example.com>",
    });

    expect(stored?.smtpPasswordSealed).toBeTruthy();
    expect(String(stored?.smtpPasswordSealed)).not.toContain("hunter2");

    const settings = await readInstanceSettings();
    expect(settings.smtp.password).toBe("hunter2");
  });

  test("a null password leaves the stored one alone", async () => {
    stored = null;
    const { readInstanceSettings, saveSmtpSettings } = await modulePromise;

    const base = {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "paco",
      from: "Paco <no-reply@example.com>",
    };

    await saveSmtpSettings({ ...base, password: "hunter2" });
    await saveSmtpSettings({ ...base, user: "changed", password: null });

    const settings = await readInstanceSettings();
    expect(settings.smtp.user).toBe("changed");
    expect(settings.smtp.password).toBe("hunter2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/settings/instance-settings.test.ts`
Expected: FAIL — `Cannot find module './instance-settings'`.

- [ ] **Step 3: Create `apps/web/lib/settings/instance-settings.ts`**

```ts
import "server-only";

import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/crypto/secret-box";
import { db } from "@/lib/db/client";
import { instanceSettings } from "@/lib/db/schema";

/**
 * The instance's own configuration, as the product reads and writes it.
 *
 * One row, keyed by a constant, matching how `allow_new_users` was already
 * stored. The SMTP password is the only value that is not plain: it is sealed,
 * because nodemailer needs the original on every send and there is nothing to
 * compare a hash against.
 */

const SETTINGS_ROW_ID = true;

export type SmtpSettingsInput = {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  user: string | null;
  /** `null` means "leave whatever is stored alone" — see `saveSmtpSettings`. */
  password: string | null;
  from: string | null;
};

export type StoredSmtpSettings = Omit<SmtpSettingsInput, "password"> & {
  password: string | null;
};

export type InstanceSettingsView = {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
  smtp: StoredSmtpSettings;
};

/**
 * Unseal a stored password, treating an unreadable one as absent.
 *
 * `APP_SECRET` changing makes every sealed value unreadable. Throwing here
 * would take down mail delivery *and* the settings page that is the only place
 * to fix it, so an unreadable password reads as "not set" and the operator is
 * asked for it again.
 */
function unsealPassword(sealed: string | null): string | null {
  if (!sealed) {
    return null;
  }

  try {
    return open(sealed);
  } catch {
    console.warn(
      "[settings] The stored SMTP password could not be read. APP_SECRET has most likely changed; re-enter it in Settings.",
    );
    return null;
  }
}

export async function readInstanceSettings(): Promise<InstanceSettingsView> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ROW_ID))
    .limit(1);

  return {
    appDomain: row?.appDomain ?? null,
    tlsEnabled: row?.tlsEnabled ?? false,
    previewBaseDomain: row?.previewBaseDomain ?? null,
    smtp: {
      host: row?.smtpHost ?? null,
      port: row?.smtpPort ?? null,
      secure: row?.smtpSecure ?? null,
      user: row?.smtpUser ?? null,
      password: unsealPassword(row?.smtpPasswordSealed ?? null),
      from: row?.smtpFrom ?? null,
    },
  };
}

export async function saveAppDomain(input: {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
}): Promise<void> {
  const values = {
    appDomain: input.appDomain,
    tlsEnabled: input.tlsEnabled,
    previewBaseDomain: input.previewBaseDomain,
    updatedAt: new Date(),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}

/**
 * Store SMTP settings.
 *
 * A `null` password means the form was submitted without retyping it, which is
 * the normal case: the value is never sent to the browser, so an edit to the
 * host or the username would otherwise wipe the password every time.
 */
export async function saveSmtpSettings(
  input: SmtpSettingsInput,
): Promise<void> {
  const values = {
    smtpHost: input.host,
    smtpPort: input.port,
    smtpSecure: input.secure,
    smtpUser: input.user,
    smtpFrom: input.from,
    updatedAt: new Date(),
    ...(input.password === null
      ? {}
      : { smtpPasswordSealed: seal(input.password) }),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/lib/settings/instance-settings.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/settings/instance-settings.ts apps/web/lib/settings/instance-settings.test.ts
git commit -m "feat: read and write instance domain and SMTP settings"
```

---

### Task 4: SMTP resolved from the database, with the environment as fallback

**Files:**
- Create: `apps/web/lib/email/smtp-config.ts`
- Create: `apps/web/lib/email/smtp-config.test.ts`
- Modify: `apps/web/lib/email/mailer.ts`
- Modify: `apps/web/app/api/auth/email-delivery/route.ts:19`

**Interfaces:**
- Consumes: `readInstanceSettings` from `@/lib/settings/instance-settings`.
- Produces:
  - `type ResolvedSmtpConfig = { host: string; port: number; secure: boolean; user: string | null; password: string | null; from: string }`
  - `resolveSmtpConfig(): Promise<ResolvedSmtpConfig | null>` — `null` when no host is configured anywhere.
  - `mailer.ts` exports `isEmailDeliveryConfigured(): Promise<boolean>` (**now async** — every caller must await) and `sendEmail(message)` unchanged in signature.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/email/smtp-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let dbSettings = {
  host: null as string | null,
  port: null as number | null,
  secure: null as boolean | null,
  user: null as string | null,
  password: null as string | null,
  from: null as string | null,
};

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({
    appDomain: null,
    tlsEnabled: false,
    previewBaseDomain: null,
    smtp: dbSettings,
  }),
}));

const modulePromise = import("./smtp-config");

const envKeys = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
];
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  dbSettings = {
    host: null,
    port: null,
    secure: null,
    user: null,
    password: null,
    from: null,
  };
});

afterEach(() => {
  for (const key of envKeys) {
    if (original[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original[key];
    }
  }
});

describe("resolveSmtpConfig", () => {
  test("returns null when nothing is configured", async () => {
    const { resolveSmtpConfig } = await modulePromise;
    expect(await resolveSmtpConfig()).toBeNull();
  });

  test("uses the environment when the database is empty", async () => {
    process.env.SMTP_HOST = "smtp.env.example";
    process.env.SMTP_PORT = "2525";
    const { resolveSmtpConfig } = await modulePromise;

    const config = await resolveSmtpConfig();
    expect(config?.host).toBe("smtp.env.example");
    expect(config?.port).toBe(2525);
  });

  test("the database wins over the environment", async () => {
    process.env.SMTP_HOST = "smtp.env.example";
    dbSettings.host = "smtp.db.example";
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.host).toBe("smtp.db.example");
  });

  test("implicit TLS is inferred from port 465", async () => {
    dbSettings.host = "smtp.db.example";
    dbSettings.port = 465;
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.secure).toBe(true);
  });

  test("an explicit secure flag beats the port heuristic", async () => {
    dbSettings.host = "smtp.db.example";
    dbSettings.port = 465;
    dbSettings.secure = false;
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.secure).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/lib/email/smtp-config.test.ts`
Expected: FAIL — `Cannot find module './smtp-config'`.

- [ ] **Step 3: Create `apps/web/lib/email/smtp-config.ts`**

```ts
import "server-only";

import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * The SMTP settings actually in force.
 *
 * Settings saved in the product win; `SMTP_*` environment variables remain a
 * fallback so existing compose deployments keep working after upgrading, and
 * so an operator can seed a new install from their own configuration
 * management without going through the UI first.
 *
 * Resolved per send rather than cached in a module-level transport: a changed
 * password should take effect on the next email, not after a restart.
 */

const DEFAULT_PORT = 587;
const IMPLICIT_TLS_PORT = 465;
const DEFAULT_FROM = "Paco <no-reply@localhost>";

export type ResolvedSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
};

function envNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function resolveSmtpConfig(): Promise<ResolvedSmtpConfig | null> {
  const { smtp } = await readInstanceSettings();

  const host = smtp.host ?? process.env.SMTP_HOST?.trim() ?? null;
  if (!host) {
    return null;
  }

  const port = smtp.port ?? envNumber(process.env.SMTP_PORT) ?? DEFAULT_PORT;

  const explicitSecure =
    smtp.secure ??
    (process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : null);

  return {
    host,
    port,
    // Implicit TLS on 465; STARTTLS elsewhere, unless told otherwise.
    secure: explicitSecure ?? port === IMPLICIT_TLS_PORT,
    user: smtp.user ?? process.env.SMTP_USER?.trim() ?? null,
    password: smtp.password ?? process.env.SMTP_PASSWORD ?? null,
    from: smtp.from ?? process.env.SMTP_FROM?.trim() ?? DEFAULT_FROM,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/lib/email/smtp-config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite the transport in `apps/web/lib/email/mailer.ts`**

Replace lines 20-80 (the `transporter` variable through the end of `sendEmail`) with:

```ts
/**
 * Whether mail actually leaves this machine.
 *
 * Async now that settings live in the database. The sign-in form has to know:
 * it used to promise "check your email" regardless, which is false on any
 * instance that has not configured SMTP — and that is the default.
 */
export async function isEmailDeliveryConfigured(): Promise<boolean> {
  return (await resolveSmtpConfig()) !== null;
}

/**
 * Deliver an email over SMTP.
 *
 * Called from the background worker, not from a request handler — SMTP latency
 * and provider outages must not block sign-in.
 *
 * The transport is built per send rather than cached. Settings are editable at
 * runtime, and a cached transport would keep using the old password until the
 * process restarted — which is exactly the kind of failure an operator cannot
 * diagnose from the outside.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const config = await resolveSmtpConfig();

  if (!config) {
    console.warn(
      `[email] SMTP is not configured; logging instead of sending.\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`,
    );
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user
      ? { user: config.user, pass: config.password ?? undefined }
      : undefined,
  });

  await transporter.sendMail({
    from: config.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}
```

Add the import at the top of the file, below the nodemailer import:

```ts
import { resolveSmtpConfig } from "./smtp-config";
```

Delete the now-unused `Transporter` type import and the `isConfigured` helper.

- [ ] **Step 6: Await the now-async check at its one caller**

In `apps/web/app/api/auth/email-delivery/route.ts` line 19:

```ts
  return Response.json({ deliversEmail: await isEmailDeliveryConfigured() });
```

Confirm the handler is already `async`; if not, make it so.

- [ ] **Step 7: Typecheck and run the email tests**

Run: `pnpm typecheck && bun test apps/web/lib/email/`
Expected: typecheck clean, tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/email apps/web/app/api/auth/email-delivery/route.ts
git commit -m "feat: resolve SMTP from settings with environment fallback"
```

---

### Task 5: Server actions for the settings UI

**Files:**
- Create: `apps/web/lib/admin/instance-settings-actions.ts`

**Interfaces:**
- Consumes: `requireAdmin` from `@/lib/admin/require-admin`; `readInstanceSettings`, `saveAppDomain`, `saveSmtpSettings` from `@/lib/settings/instance-settings`; `resolveSmtpConfig` from `@/lib/email/smtp-config`; `sendEmail` from `@/lib/email/mailer`.
- Produces:
  - `getInstanceSettings(): Promise<{ appDomain: string | null; tlsEnabled: boolean; previewBaseDomain: string | null; smtp: { host, port, secure, user, from, hasPassword: boolean } }>` — note **no password**.
  - `updateAppDomain(input): Promise<{ success: boolean; error?: string }>`
  - `updateSmtpSettings(input): Promise<{ success: boolean; error?: string }>`
  - `sendTestEmail(to: string): Promise<{ success: boolean; error?: string }>`

- [ ] **Step 1: Create the file**

```ts
"use server";

import { z } from "zod";
import { sendEmail } from "@/lib/email/mailer";
import { resolveSmtpConfig } from "@/lib/email/smtp-config";
import {
  readInstanceSettings,
  saveAppDomain,
  saveSmtpSettings,
} from "@/lib/settings/instance-settings";
import { requireAdmin } from "./require-admin";

/**
 * The settings an administrator can change about this installation.
 *
 * The SMTP password travels one way only. `getInstanceSettings` reports
 * whether one is stored, never what it is — a settings page is exactly the
 * screen an over-broad response would leak a credential from.
 */

const domainSchema = z.object({
  appDomain: z
    .string()
    .trim()
    .url("Enter the full address, including https://")
    .nullable(),
  tlsEnabled: z.boolean(),
  previewBaseDomain: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9.-]+$/,
      "Enter a bare domain such as previews.example.com, with no scheme",
    )
    .nullable(),
});

const smtpSchema = z.object({
  host: z.string().trim().min(1).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  secure: z.boolean().nullable(),
  user: z.string().trim().nullable(),
  password: z.string().nullable(),
  from: z.string().trim().min(1).nullable(),
});

export async function getInstanceSettings() {
  await requireAdmin();
  const settings = await readInstanceSettings();

  return {
    appDomain: settings.appDomain,
    tlsEnabled: settings.tlsEnabled,
    previewBaseDomain: settings.previewBaseDomain,
    smtp: {
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      user: settings.smtp.user,
      from: settings.smtp.from,
      hasPassword: settings.smtp.password !== null,
    },
  };
}

export async function updateAppDomain(
  input: z.infer<typeof domainSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = domainSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveAppDomain(parsed.data);
  return { success: true };
}

export async function updateSmtpSettings(
  input: z.infer<typeof smtpSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = smtpSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveSmtpSettings(parsed.data);
  return { success: true };
}

/**
 * Prove the SMTP settings work, before an invitation depends on them.
 *
 * Sent inline rather than queued: the point is to report the failure to the
 * person who just typed the settings in, and a queued job would swallow it
 * into a worker log.
 */
export async function sendTestEmail(
  to: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const address = z.string().trim().email().safeParse(to);
  if (!address.success) {
    return { success: false, error: "That does not look like an email address." };
  }

  if (!(await resolveSmtpConfig())) {
    return {
      success: false,
      error: "Set a mail server first — there is nothing to send with yet.",
    };
  }

  try {
    await sendEmail({
      to: address.data,
      subject: "Paco test email",
      text: "This is a test message from Paco. Your mail settings work.",
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The mail server refused the message.",
    };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean. If `requireAdmin` is not at `@/lib/admin/require-admin`, correct the import to match `apps/web/lib/admin/actions.ts` line 6.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/admin/instance-settings-actions.ts
git commit -m "feat: add server actions for domain and SMTP settings"
```

---

### Task 6: The entrypoint exports `APP_URL` from the database

**Files:**
- Modify: `docker-entrypoint.sh`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the `instance_settings.app_domain` column from Task 2.
- Produces: an `APP_URL` environment variable in the server process, set from the database when the operator has not set one explicitly.

- [ ] **Step 1: Remove the build-time variable from `Dockerfile`**

Delete lines 58-59:

```dockerfile
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
```

Nothing replaces them. The build no longer knows or needs the public origin.

- [ ] **Step 2: Remove the build block and pass `APP_URL` at runtime in `docker-compose.yml`**

Replace the `paco` service's `build:` block with the published image, and rename the environment key:

```yaml
  paco:
    image: ghcr.io/krova-admin/paco:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      POSTGRES_URL: ${POSTGRES_URL}
      APP_SECRET: ${APP_SECRET}
      # Optional. Unset means "use the domain saved in Settings, or localhost".
      APP_URL: ${APP_URL:-}
```

Leave the remaining `SMTP_*` entries in place — they are still honoured as a fallback — and leave the volumes, `depends_on` and the `postgres` service untouched. Update the comment at the top of the file that refers to building.

- [ ] **Step 3: Resolve the domain in `docker-entrypoint.sh`**

The file already validates `POSTGRES_URL` and `APP_SECRET` and refuses to start without them. Delete the `NEXT_PUBLIC_APP_URL` check on line 17 — it is no longer required — and add this after the migrations run, immediately before the server is exec'd:

```sh
# The public origin has to be known before the server starts: better-auth builds
# its set of trusted callback hosts once, at module load. An operator who sets a
# domain in Settings saves it to the database and restarts, and this is what
# turns that row back into configuration.
#
# An explicitly-provided APP_URL always wins, so an operator who prefers to
# manage it as environment can, and this query never overrides them.
if [ -z "$APP_URL" ]; then
  APP_URL_FROM_DB="$(
    psql "$POSTGRES_URL" -tAc \
      "SELECT app_domain FROM instance_settings WHERE app_domain IS NOT NULL LIMIT 1" \
      2>/dev/null || true
  )"
  if [ -n "$APP_URL_FROM_DB" ]; then
    export APP_URL="$APP_URL_FROM_DB"
    echo "paco: serving on $APP_URL (from Settings)"
  fi
fi
```

`psql` must exist in the runtime image. The runtime stage is
`node:24-bookworm-slim` (`Dockerfile:70`) and already installs packages at
`Dockerfile:81` — add `postgresql-client` to that existing list rather than
adding a second `RUN`, so the image keeps one apt layer.

- [ ] **Step 4: Verify the image builds and starts**

Run:

```bash
docker compose build paco
docker compose up -d
docker compose logs paco | tail -20
```

Expected: the build succeeds with no `NEXT_PUBLIC_APP_URL` build argument, and the log shows the app listening. With no domain saved, no "from Settings" line appears.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml docker-entrypoint.sh
git commit -m "feat: resolve the public origin at start-up instead of build time"
```

---

### Task 7: Restart endpoint

**Files:**
- Create: `apps/web/app/api/admin/restart/route.ts`

**Interfaces:**
- Consumes: `requireAdmin` from `@/lib/admin/require-admin`.
- Produces: `POST /api/admin/restart` → `{ restarting: true }`, or `{ error: string }` with status 500.

- [ ] **Step 1: Create the route**

```ts
import { requireAdmin } from "@/lib/admin/require-admin";

/**
 * Restart Paco's own container.
 *
 * A domain saved in Settings only reaches better-auth's trusted-host list when
 * the process starts, so "save" alone leaves the instance in a state where the
 * new address is configured but not yet honoured. Rather than explain that,
 * the settings page offers the restart — through the Docker socket Paco
 * already mounts to create sandboxes.
 *
 * The request is answered *before* the restart is issued. Docker stops this
 * container to restart it, so a response written afterwards would never arrive
 * and the browser would show a network error for an action that worked.
 */
export async function POST(): Promise<Response> {
  await requireAdmin();

  const containerName = process.env.HOSTNAME;
  if (!containerName) {
    return Response.json(
      {
        error:
          "Paco cannot tell which container it is running in, so it cannot restart itself. Restart it from the host with `paco restart`.",
      },
      { status: 500 },
    );
  }

  // Detached: the process must not be waiting on a command that kills it.
  setTimeout(() => {
    void import("node:child_process").then(({ spawn }) => {
      spawn("docker", ["restart", containerName], {
        detached: true,
        stdio: "ignore",
      }).unref();
    });
  }, 500);

  return Response.json({ restarting: true });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/admin/restart/route.ts
git commit -m "feat: let an administrator restart the instance from settings"
```

---

### Task 8: Settings UI for domain and SMTP

**Files:**
- Create: `apps/web/app/settings/admin/domain-section.tsx`
- Create: `apps/web/app/settings/admin/smtp-section.tsx`
- Modify: `apps/web/app/settings/admin/page.tsx:75`

**Interfaces:**
- Consumes: `getInstanceSettings`, `updateAppDomain`, `updateSmtpSettings`, `sendTestEmail` from `@/lib/admin/instance-settings-actions`; `toast` from `@/lib/toast`.
- Produces: `<DomainSection />` and `<SmtpSection />`, both client components taking no props.

- [ ] **Step 1: Set up the daisyUI workflow**

This is UI work, so it goes through the MCP before any markup is written. Call `daisyui_setup_expert` with `workflowId: "paco-instance-settings"` and `projectRoot: "/Users/rbonweb/Desktop/paco"`, then the mandatory `daisyui_rules_enforcer`, then `daisyui_component_syntax_expert` for the components used — form control, input, select, toggle, button, alert, card. Repeat `daisyui_component_syntax_expert` until it reports no remaining snippet IDs.

- [ ] **Step 2: Build `domain-section.tsx`**

Follow the structure of `apps/web/app/settings/signup-access-section.tsx`: `"use client"`, load current values in an effect with a `cancelled` guard, optimistic local state, `toast` for success and failure.

Requirements the markup must satisfy:

- Fields: **address** (the full origin, e.g. `https://paco.example.com`), **preview domain** (bare, e.g. `previews.example.com`), and a **TLS toggle**.
- The TLS toggle's help text states that certificates are requested per hostname over HTTP, so the domain must already resolve to this server before it is turned on.
- After a successful save, render an alert: the new address is saved but does not take effect until Paco restarts, with a **Restart now** button that `POST`s to `/api/admin/restart`. After posting, tell the user the page will be unavailable for a few seconds.
- The section must not claim the domain is live. Wording is "saved", not "applied", until the restart happens.

- [ ] **Step 3: Build `smtp-section.tsx`**

Requirements:

- Fields: host, port, encryption (a select: *Automatic*, *TLS on connect*, *STARTTLS*, mapping to `secure` `null`/`true`/`false`), username, password, from-address.
- The password field renders empty with placeholder text saying a password is already stored when `smtp.hasPassword` is true, and submits `null` when left untouched — matching `saveSmtpSettings`, which treats `null` as "leave it alone".
- A **Send test email** button, defaulting the address to the signed-in administrator's own, showing the returned error verbatim on failure. An SMTP error message is the single most useful thing on this screen; do not replace it with a generic sentence.
- The section explains that these settings are what invitations are delivered with, so they should be set before anyone is invited.

- [ ] **Step 4: Mount both sections**

In `apps/web/app/settings/admin/page.tsx`, import both and render them next to `<SignupAccessSection />` at line 75, domain first.

- [ ] **Step 5: Audit the UI**

Run `daisyui_quality_inspector` with `auditIntent: "fix_changes"` and both new files' paths **relative to `projectRoot`**, then apply what it reports.

- [ ] **Step 6: Verify in the running app**

Start the server detached so it survives the shell that launched it:

```bash
cd /Users/rbonweb/Desktop/paco
nohup pnpm web > /tmp/paco-dev.log 2>&1 < /dev/null & disown
```

Sign in, open `/settings/admin`, and check: saving a domain shows the restart prompt; saving SMTP with a bad host and pressing *Send test email* surfaces the real SMTP error; reloading shows the password field empty with the "already stored" placeholder.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/settings/admin
git commit -m "feat: configure the domain and mail server from settings"
```

---

### Task 9: Phase close-out

- [ ] **Step 1: Confirm the old variable is gone everywhere**

Run: `grep -rn "NEXT_PUBLIC_APP_URL" . --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.sh" --include="*.example" --include="Dockerfile" | grep -v node_modules | grep -v '/.next/'`
Expected: no output.

- [ ] **Step 2: Confirm the built server no longer bakes an origin**

```bash
pnpm --dir apps/web build
grep -rl "localhost:3066" apps/web/.next/server --include="*.js" | wc -l
```

Expected: `0`. This is the check that proves the published image can serve any installation — if it is non-zero the rename did not take, and the whole phase is undone.

- [ ] **Step 3: Run the full checks, once**

Run: `pnpm run ci`
Expected: format, lint, typecheck, the full test suite, and `✓ Migrations are in sync with schema.ts`.

- [ ] **Step 4: Commit any formatting the run applied**

```bash
pnpm fix
git add -A
git commit -m "chore: formatting after phase 1"
```

---

## Self-Review

**Spec coverage.** Every Phase 1 requirement maps to a task: the rename and its resolution order (Task 1), the new columns (Task 2), reading and writing them with the password sealed (Task 3), SMTP resolved database-then-environment (Task 4), the test-email action (Task 5), start-up resolution and the packaging changes that make one public image possible (Task 6), the restart affordance (Tasks 7 and 8), and the Settings UI (Task 8). The spec's `resolvedAppUrl()` no longer appears, because the entrypoint approach replaced it — the spec was updated to match before this plan was written.

**Deferred deliberately.** `preview_base_domain` and `tls_enabled` are stored and editable here but nothing consumes them until Phase 4. They are in Phase 1 because adding them now costs one migration instead of two, and because the domain screen would otherwise have to be rebuilt.

**Type consistency.** `SmtpSettingsInput.password: string | null` in Task 3 is what Task 5's `smtpSchema.password` produces and what Task 8's form submits as `null` when untouched. `isEmailDeliveryConfigured()` becomes `Promise<boolean>` in Task 4 and its single caller is updated in the same task. `readInstanceSettings()` returns `InstanceSettingsView`, which is what Task 4's mock shapes and Task 5's `getInstanceSettings` narrows.

**Known risk.** Task 6 adds `psql` to the runtime image, which grows it slightly. The alternative — a Node script that opens a database connection before `exec` — needs the app's dependencies resolvable at that point in the entrypoint, which is a larger change to the image layout for the same result.
