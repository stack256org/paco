import { describe, expect, test } from "bun:test";
import { DEFAULT_GIT_USER, resolveGitUser } from "./config.ts";

describe("resolveGitUser", () => {
  test("keeps a complete identity", () => {
    expect(
      resolveGitUser({ name: "Ada Lovelace", email: "ada@example.com" }),
    ).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("fills in a blank name while keeping the real email", () => {
    // A GitHub account with no display name produces exactly this. `??` let it
    // through and git rejected the commit with "empty ident name", which broke
    // worktree creation and so made every chat unstartable.
    expect(
      resolveGitUser({ name: "", email: "user@users.noreply.github.com" }),
    ).toEqual({
      name: DEFAULT_GIT_USER.name,
      email: "user@users.noreply.github.com",
    });
  });

  test("treats whitespace as blank", () => {
    expect(resolveGitUser({ name: "   ", email: "  " })).toEqual({
      name: DEFAULT_GIT_USER.name,
      email: DEFAULT_GIT_USER.email,
    });
  });

  test("substitutes both halves when nothing is supplied", () => {
    // git refuses to commit without an identity, and Paco commits on the
    // agent's behalf, so there is always one.
    expect(resolveGitUser()).toEqual({
      name: DEFAULT_GIT_USER.name,
      email: DEFAULT_GIT_USER.email,
    });
    expect(resolveGitUser({})).toEqual({
      name: DEFAULT_GIT_USER.name,
      email: DEFAULT_GIT_USER.email,
    });
  });

  test("fills each half independently", () => {
    expect(resolveGitUser({ name: "Ada Lovelace" })).toEqual({
      name: "Ada Lovelace",
      email: DEFAULT_GIT_USER.email,
    });
  });
});
