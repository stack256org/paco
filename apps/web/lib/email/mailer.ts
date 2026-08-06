import "server-only";

import nodemailer from "nodemailer";

import { resolveSmtpConfig } from "./smtp-config";

/**
 * SMTP transport.
 *
 * Any SMTP provider works; nothing here is vendor-specific. In development,
 * leaving SMTP unconfigured logs the message instead of failing, so magic-link
 * sign-in still works without an email account.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

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

/** Render the magic-link sign-in email. */
export function buildMagicLinkEmail(params: {
  url: string;
  expiresInMinutes: number;
}): Pick<EmailMessage, "subject" | "text" | "html"> {
  const { url, expiresInMinutes } = params;

  return {
    subject: "Your Paco sign-in link",
    text: [
      "Sign in to Paco using the link below.",
      "",
      url,
      "",
      `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
      "If you didn't request it, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.6; color: #111;">
        <h2 style="margin: 0 0 16px; font-size: 18px;">Sign in to Paco</h2>
        <p style="margin: 0 0 24px;">Click the button below to sign in.</p>
        <p style="margin: 0 0 24px;">
          <a href="${url}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; border-radius: 6px; text-decoration: none;">Sign in</a>
        </p>
        <p style="margin: 0 0 8px; font-size: 13px; color: #555;">
          This link expires in ${expiresInMinutes} minutes and can only be used once.
        </p>
        <p style="margin: 0; font-size: 13px; color: #555;">
          If you didn't request it, you can ignore this email.
        </p>
      </div>
    `.trim(),
  };
}
