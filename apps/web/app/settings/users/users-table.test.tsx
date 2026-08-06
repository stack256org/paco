import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { UsersTable } from "./users-table";
import type { AdminUser } from "@/lib/admin/list-users";

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u1",
    username: "founder",
    email: "founder@example.com",
    name: null,
    isAdmin: false,
    createdAt: new Date("2026-07-29T05:44:53Z"),
    lastLoginAt: new Date("2026-07-30T03:12:46Z"),
    ...overrides,
  };
}

describe("UsersTable", () => {
  test("lists every account, not just the signed-in one", () => {
    // The whole point of the page: Profile shows one account, this shows all.
    const html = renderToStaticMarkup(
      <UsersTable
        users={[
          user({ id: "u1", email: "founder@example.com" }),
          user({ id: "u2", email: "second@example.com" }),
          user({ id: "u3", email: "third@example.com" }),
        ]}
      />,
    );

    expect(html).toContain("founder@example.com");
    expect(html).toContain("second@example.com");
    expect(html).toContain("third@example.com");
  });

  test("marks administrators", () => {
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ isAdmin: true })]} />,
    );

    expect(html).toContain("Admin");
  });

  test("does not mark ordinary accounts as administrators", () => {
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ isAdmin: false })]} />,
    );

    expect(html).not.toContain(">Admin<");
  });

  test("prefers a display name over the username", () => {
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ name: "Ada Lovelace" })]} />,
    );

    expect(html).toContain("Ada Lovelace");
  });

  test("falls back to the username when the name is blank, not just null", () => {
    // better-auth writes "" rather than NULL for a name it was never given,
    // and `??` does not fall back on an empty string — the row rendered with
    // no name at all.
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ name: "", username: "founder" })]} />,
    );

    expect(html).toContain("founder");
  });

  test("says so when an account has no email", () => {
    // Sign-in is by magic link, so such an account cannot be reached at all —
    // worth stating rather than rendering an empty cell that reads as a bug.
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ email: null })]} />,
    );

    expect(html).toContain("No email");
  });

  test("treats a blank email as no email", () => {
    const html = renderToStaticMarkup(
      <UsersTable users={[user({ email: "  " })]} />,
    );

    expect(html).toContain("No email");
  });
});
