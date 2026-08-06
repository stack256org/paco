import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let session: { user: { id: string } } | null = null;
let isUserAdminFlag = false;
let isOrgAdminFlag = false;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => session,
}));

mock.module("@/lib/db/users", () => ({
  isUserAdmin: async () => isUserAdminFlag,
}));

mock.module("@/lib/org/membership", () => ({
  isOrganizationAdmin: async () => isOrgAdminFlag,
}));

const modulePromise = import("./require-admin");

describe("isAdmin / requireAdmin", () => {
  test("an org admin who is not users.is_admin still passes", async () => {
    isUserAdminFlag = false;
    isOrgAdminFlag = true;
    session = { user: { id: "org-admin-1" } };
    const { isAdmin, requireAdmin } = await modulePromise;

    expect(await isAdmin("org-admin-1")).toBe(true);
    expect(await requireAdmin()).toBe("org-admin-1");
  });

  test("users.is_admin alone (no org role) still passes — the OR is not a replacement", async () => {
    isUserAdminFlag = true;
    isOrgAdminFlag = false;
    session = { user: { id: "legacy-admin-1" } };
    const { isAdmin, requireAdmin } = await modulePromise;

    expect(await isAdmin("legacy-admin-1")).toBe(true);
    expect(await requireAdmin()).toBe("legacy-admin-1");
  });

  test("a plain member — neither flag nor org role — is refused", async () => {
    isUserAdminFlag = false;
    isOrgAdminFlag = false;
    session = { user: { id: "member-1" } };
    const { isAdmin, requireAdmin } = await modulePromise;

    expect(await isAdmin("member-1")).toBe(false);
    await expect(requireAdmin()).rejects.toThrow();
  });

  test("signed out is refused before either admin source is even asked", async () => {
    session = null;
    const { requireAdmin } = await modulePromise;

    await expect(requireAdmin()).rejects.toThrow();
  });
});
