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

    expect(assertSignUpAllowed("invited@example.com")).resolves.toBeUndefined();
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
