import { describe, expect, mock, test } from "bun:test";

mock.module("./client", () => ({
  db: {},
}));

const userPreferencesModulePromise = import("./user-preferences");

describe("toUserPreferencesData", () => {
  test("returns defaults when row is undefined", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    // Saving locally is on and publishing is off: a commit stays on this
    // machine, a push goes out under the owner's GitHub account.
    expect(toUserPreferencesData()).toEqual({
      defaultModelId: "opus",
      defaultDiffMode: "unified",
      autoCommitLocal: true,
      autoCommitPush: false,
      autoCreatePr: false,
      alertsEnabled: true,
      alertSoundEnabled: true,
    });
  });

  test("keeps auto-save off for someone who turned it off", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    // `?? true` would read a stored `false` as "unset" and turn it back on.
    expect(
      toUserPreferencesData({
        defaultModelId: "opus",
        defaultDiffMode: "unified",
        autoCommitLocal: false,
        autoCommitPush: false,
        autoCreatePr: false,
        alertsEnabled: true,
        alertSoundEnabled: true,
      }).autoCommitLocal,
    ).toBe(false);
  });
});
