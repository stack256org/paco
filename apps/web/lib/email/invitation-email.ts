import { escapeHtml } from "./escape-html";
import type { EmailMessage } from "./mailer";

/**
 * Render the invitation email.
 *
 * Sits beside `buildMagicLinkEmail` in shape and voice, but the two are
 * distinct emails, not one template with a flag: a magic link is a request
 * the recipient made a minute ago, and an invitation is unsolicited — it has
 * to say who sent it and what they're being invited to before it asks for a
 * click.
 */
export function buildInvitationEmail(params: {
  url: string;
  invitedByEmail: string;
  expiresAt: Date;
}): Pick<EmailMessage, "subject" | "text" | "html"> {
  const { url, invitedByEmail, expiresAt } = params;
  const expiry = expiresAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // `text` below stays raw — it's a plain-text email body, where none of
  // these characters are special. Only the `html` field needs escaping.
  const safeUrl = escapeHtml(url);
  const safeInvitedByEmail = escapeHtml(invitedByEmail);

  return {
    subject: "You're invited to Paco",
    text: [
      `${invitedByEmail} invited you to join their team on Paco.`,
      "",
      "Paco is a self-hosted AI coding agent that writes and tests code in your own repositories.",
      "",
      url,
      "",
      `This invitation expires on ${expiry} and can only be used once.`,
      "If you weren't expecting this, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.6; color: #111;">
        <h2 style="margin: 0 0 16px; font-size: 18px;">You're invited to Paco</h2>
        <p style="margin: 0 0 8px;">
          <strong>${safeInvitedByEmail}</strong> invited you to join their team on Paco.
        </p>
        <p style="margin: 0 0 24px; color: #555;">
          Paco is a self-hosted AI coding agent that writes and tests code in your own repositories.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${safeUrl}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; border-radius: 6px; text-decoration: none;">Accept invitation</a>
        </p>
        <p style="margin: 0 0 8px; font-size: 13px; color: #555;">
          This invitation expires on ${expiry} and can only be used once.
        </p>
        <p style="margin: 0; font-size: 13px; color: #555;">
          If you weren't expecting this, you can ignore this email.
        </p>
      </div>
    `.trim(),
  };
}
