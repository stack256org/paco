import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { nanoid } from "nanoid";
import { appHost, appUrl } from "@/lib/app-url";
import { buildMagicLinkEmail } from "@/lib/email/mailer";
import { enqueue, QUEUES } from "@/lib/jobs/queue";
import { promoteFirstUserToAdmin } from "@/lib/auth/bootstrap-admin";
import { readTokenCapture } from "@/lib/auth/first-run-token-capture";
import {
  assertSignUpAllowed,
  SIGNUP_DISABLED_CODE,
} from "@/lib/auth/signup-policy";
import { deriveAuthUsername } from "@/lib/auth/username";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  acceptInvitation,
  findLiveInvitationByEmail,
} from "@/lib/org/invitations";

function getWildcardHostPattern(host: string): string | null {
  const hostname = host.split(":")[0];
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("[")
  ) {
    return null;
  }

  return `*.${host}`;
}

/**
 * The origins better-auth will accept a magic-link callback from.
 *
 * Derived only from `APP_URL`, which is the origin the link itself
 * is built with — so the two cannot disagree. Seeding a `localhost:<port>`
 * default here instead would go stale the moment the origin changed, and it
 * fails quietly: the app runs, and the callback is rejected as untrusted.
 */
function getAllowedAuthHosts(): string[] {
  const host = appHost();
  const hosts = new Set<string>([host]);

  const wildcardPattern = getWildcardHostPattern(host);
  if (wildcardPattern) {
    hosts.add(wildcardPattern);
  }

  return [...hosts];
}

const authBaseURL = appUrl().origin;
const authAllowedHosts = getAllowedAuthHosts();

/** Magic links are single-use and short-lived. */
const MAGIC_LINK_EXPIRY_SECONDS = 600;

export const auth = betterAuth({
  secret: process.env.APP_SECRET,
  baseURL: {
    allowedHosts: authAllowedHosts,
    fallback: authBaseURL,
  },

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      users: schema.users,
      auth_sessions: schema.authSessions,
      account: schema.accounts,
      verification: schema.verification,
    },
  }),

  user: {
    modelName: "users",
    additionalFields: {
      username: { type: "string", required: true },
      lastLoginAt: { type: "date", required: false },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Refuses a brand-new account unless this instance allows them. Runs
          // only for accounts that do not exist yet, so signing in is
          // unaffected. An account with no address cannot have been invited,
          // so a missing email is refused rather than treated as exempt.
          if (!user.email) {
            throw new APIError("FORBIDDEN", {
              code: SIGNUP_DISABLED_CODE,
              message:
                "This Paco instance is invitation-only. Ask an administrator for an invitation.",
            });
          }
          await assertSignUpAllowed(user.email);

          return {
            data: {
              username: deriveAuthUsername(user),
            },
          };
        },
        // Runs after the row exists, so the "is anyone else admin?" test can
        // see it, the promotion is a single conditional statement, and an
        // invitation's membership insert has a user row for its foreign key
        // to resolve against.
        after: async (user) => {
          await promoteFirstUserToAdmin(user.id);

          if (user.email) {
            const invitation = await findLiveInvitationByEmail(user.email);
            if (invitation) {
              await acceptInvitation(invitation.token, user.id);
            }
          }
        },
      },
    },
  },

  session: {
    modelName: "auth_sessions",
  },

  account: {
    encryptOAuthTokens: true,
  },

  /*
   * No social providers.
   *
   * GitHub used to be one, so the App could borrow the user's OAuth token.
   * Paco talks to GitHub through `gh` with a token the user supplies in
   * Settings, so there is nothing left for an OAuth app to do — and declaring
   * a provider with no credentials made better-auth warn on every request.
   */

  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
      sendMagicLink: async ({ email, url, token, metadata }) => {
        // First-run registration (`POST /api/auth/first-run`) passes a
        // capture function instead of letting this queue an email — see
        // `first-run-token-capture.ts`. It verifies the token itself, in the
        // same request, so nobody has to read a server log to reach their
        // own fresh install.
        const capture = readTokenCapture(metadata);
        if (capture) {
          capture(token);
          return;
        }

        // Queued rather than sent inline: SMTP latency must not block the
        // sign-in request, and pg-boss retries transient delivery failures.
        await enqueue(QUEUES.sendEmail, {
          to: email,
          ...buildMagicLinkEmail({
            url,
            expiresInMinutes: MAGIC_LINK_EXPIRY_SECONDS / 60,
          }),
        });
      },
    }),
  ],

  advanced: {
    database: {
      generateId: () => nanoid(),
    },
  },
});
