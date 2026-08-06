import "server-only";

import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * The SMTP settings actually in force.
 *
 * The source is all-or-nothing, decided once for the whole config rather than
 * per field: if Settings has a host saved, every field — host, port, user,
 * password, from — comes from the database, and every `SMTP_*` environment
 * variable is ignored, including ones the database has no opinion on. Only
 * when Settings has no host does the environment apply at all, and then it
 * supplies the whole config too. This exists so an operator migrating from
 * environment SMTP to Settings can't end up with one provider's host and
 * another provider's leftover credentials — filling in only the host in
 * Settings does not "inherit" `SMTP_USER`/`SMTP_PASSWORD` from the
 * environment; it sends unauthenticated. Username and password have to be
 * entered in Settings too, even if they are already set in the environment.
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

  // The source has to be atomic — the database wholly, or the environment
  // wholly — not decided per field. A per-field fallback (the previous
  // behaviour) means an operator who configures a new host in Settings but
  // leaves, say, the username blank silently inherits `SMTP_USER` and
  // `SMTP_PASSWORD` from whatever provider the environment was set up for,
  // and nodemailer AUTHs against the new host with the old provider's
  // credentials. One provider's secret, sent to a server that isn't it.
  if (smtp.host) {
    const port = smtp.port ?? DEFAULT_PORT;
    return {
      host: smtp.host,
      port,
      // Implicit TLS on 465; STARTTLS elsewhere, unless told otherwise.
      secure: smtp.secure ?? port === IMPLICIT_TLS_PORT,
      user: smtp.user,
      password: smtp.password,
      from: smtp.from ?? DEFAULT_FROM,
    };
  }

  const host = process.env.SMTP_HOST?.trim() ?? null;
  if (!host) {
    return null;
  }

  const port = envNumber(process.env.SMTP_PORT) ?? DEFAULT_PORT;

  return {
    host,
    port,
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true"
      : port === IMPLICIT_TLS_PORT,
    user: process.env.SMTP_USER?.trim() ?? null,
    password: process.env.SMTP_PASSWORD ?? null,
    from: process.env.SMTP_FROM?.trim() ?? DEFAULT_FROM,
  };
}
