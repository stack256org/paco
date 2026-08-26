"use server";

import { tmpdir } from "node:os";
import type { z } from "zod";
import { sendEmail } from "@/lib/email/mailer";
import { resolveSmtpConfig } from "@/lib/email/smtp-config";
import {
  markOnboardingComplete,
  readInstanceSettings,
  saveAppDomain,
  savePoolsideSettings,
  saveSmtpSettings,
} from "@/lib/settings/instance-settings";
import {
  domainSchema,
  emailAddressSchema,
  poolsideSchema,
  smtpSchema,
} from "./instance-settings-schemas";
import { requireAdmin } from "./require-admin";

/**
 * The settings an administrator can change about this installation.
 *
 * The SMTP password and the Poolside API key travel one way only.
 * `getInstanceSettings` reports whether one is stored, never what it is — a
 * settings page is exactly the screen an over-broad response would leak a
 * credential from.
 */
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
    poolside: {
      baseUrl: settings.poolside.baseUrl,
      binaryPath: settings.poolside.binaryPath,
      // A boolean, never the key itself.
      hasApiKey: settings.poolside.apiKey !== null,
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

export async function updatePoolsideSettings(
  input: z.infer<typeof poolsideSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = poolsideSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await savePoolsideSettings(parsed.data);
  return { success: true };
}

/** How long `testPoolsideConnection` waits before giving up on a hung process. */
const POOLSIDE_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Prove the stored Poolside settings actually reach a running `pool acp`
 * process, before a chat depends on them.
 *
 * A cheap handshake: spawn the binary, send `initialize`, and tear the
 * process down the moment it answers — the same first frame
 * `PoolsideBackend.startTurn` exchanges on every real turn, without creating
 * a session or running a prompt. `cwd` is `tmpdir()` rather than a chat's
 * worktree: the workspace root only matters once a session exists, and this
 * test never creates one. (It is also why the handshake is cheap in a second
 * sense — `pool` inlines a session cwd's `AGENTS.md` into its system prompt,
 * and an empty temp directory has none.)
 *
 * What a green result does and does NOT prove, so the UI can say so rather
 * than imply more: it proves the binary at `binaryPath` exists, runs and
 * speaks ACP. It does NOT prove the API key is valid, because `initialize`
 * does not authenticate — the first real turn is what exercises the
 * credential.
 *
 * `serviceMode` is what makes the green tick checkable rather than merely
 * reassuring. A wrong `baseUrl` is the likeliest mistake on this form and is
 * otherwise invisible: the handshake succeeds against the wrong endpoint
 * exactly as happily as the right one. `agentCapabilities._meta`'s
 * `poolside/service_mode` is a string echoing the endpoint the binary
 * actually resolved (`"provider: inference.poolside.ai"` by default), so an
 * operator can compare it with what they typed. Optional on purpose: a build
 * that does not report it must leave the caller making the weaker claim
 * rather than rendering an empty endpoint.
 */
export async function testPoolsideConnection(): Promise<{
  success: boolean;
  error?: string;
  /** The endpoint the binary resolved, when it reported one. */
  serviceMode?: string;
}> {
  await requireAdmin();

  const settings = await readInstanceSettings();
  /*
   * No "configure something first" guard.
   *
   * There used to be one, refusing to run unless a binary path, base URL or
   * API key was set. It predated `paco auth poolside`: a host signed in with
   * `pool login` has none of the three — `pool` is on PATH and the credential
   * lives in the service user's config directory — and that is precisely the
   * host whose operator most wants to press this button, because nothing on
   * the page reflects a credential they set from a terminal.
   *
   * Spawning with nothing configured is also the cheaper answer: the probe is
   * one local `initialize` with a 10s bound, and its real failure ("pool: not
   * found", "Authentication required") tells the operator more than a
   * pre-emptive refusal that describes the form rather than the host.
   */

  // Imported lazily: this module is a server-action entry point pulled in by
  // every settings save, and the backend package spawns processes.
  const { AcpClient, buildPoolsideBackendConfig } =
    await import("@paco/poolside-backend");
  // The same mapping a real turn uses (`buildPoolsideBackendConfig` in
  // `lib/agent/backend-factory.ts`'s `resolveBackend`), so a passing test
  // means the settings a turn would run with are the settings that were
  // tested — not a second, hand-written approximation of them.
  const { executable, env } = buildPoolsideBackendConfig(settings.poolside);
  const client = new AcpClient({
    cwd: tmpdir(),
    ...(executable ? { executable } : {}),
    ...(env ? { env } : {}),
  });

  try {
    const result = await Promise.race([
      client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new Error("The Poolside binary did not respond in time.")),
          POOLSIDE_HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
    const serviceMode =
      result.agentCapabilities._meta?.["poolside/service_mode"];
    return {
      success: true,
      // Only forwarded when it really is a string. `_meta` is
      // `Record<string, unknown>` — an agent build that reports this key as
      // something else must leave the field absent, so the UI falls back to
      // the weaker claim instead of rendering an object.
      ...(typeof serviceMode === "string" && serviceMode !== ""
        ? { serviceMode }
        : {}),
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The Poolside binary did not respond.",
    };
  } finally {
    await client.close();
  }
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

  const address = emailAddressSchema.safeParse(to);
  if (!address.success) {
    return {
      success: false,
      error: "That does not look like an email address.",
    };
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

/**
 * Mark the guided first-run flow finished, so `/onboarding` stops offering
 * itself to this admin.
 *
 * Called once, from the "Done" step — but idempotent, since nothing stops an
 * admin from getting back there (a bookmark, a back button) after they
 * already have.
 */
export async function completeOnboarding(): Promise<{ success: boolean }> {
  await requireAdmin();
  await markOnboardingComplete();
  return { success: true };
}
