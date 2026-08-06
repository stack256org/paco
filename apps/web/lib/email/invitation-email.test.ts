import { describe, expect, test } from "bun:test";
import { buildInvitationEmail } from "./invitation-email";

describe("buildInvitationEmail", () => {
  test("escapes invitedByEmail and url in the html body, but not in text", () => {
    const email = buildInvitationEmail({
      expiresAt: new Date("2026-01-01"),
      invitedByEmail: '<img src=x onerror="alert(1)">',
      url: 'https://example.com/?x="><script>alert(1)</script>',
    });

    expect(email.html).not.toContain("<img src=x onerror=");
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );

    // Plain text is not HTML, so it stays exactly what was passed in.
    expect(email.text).toContain('<img src=x onerror="alert(1)">');
  });

  test("renders a normal invitation unremarkably", () => {
    const email = buildInvitationEmail({
      expiresAt: new Date("2026-01-01"),
      invitedByEmail: "admin@corp.com",
      url: "https://paco.example/?invitation=tok",
    });

    expect(email.subject).toBe("You're invited to Paco");
    expect(email.html).toContain("admin@corp.com");
    expect(email.html).toContain("https://paco.example/?invitation=tok");
  });
});
