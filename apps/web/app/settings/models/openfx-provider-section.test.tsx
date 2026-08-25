import { describe, expect, mock, test } from "bun:test";
import { OpenFxBackend } from "@paco/openfx-backend";

mock.module("@/lib/admin/instance-settings-actions", () => ({
  getInstanceSettings: () => Promise.resolve(null),
  testOpenFxConnection: () => Promise.resolve({ success: true }),
  updateOpenFxSettings: () => Promise.resolve({ success: true }),
}));
mock.module("@/lib/toast", () => ({
  toast: { error: () => {}, success: () => {} },
}));

const modulePromise = import("./openfx-provider-section");

/**
 * Anything the backend reports as unsupported: `false`, or an empty list of
 * accepted values. The settings page has to account for every one of them,
 * or it is advertising something a chat switched to OpenFX cannot do.
 */
function unsupportedCapabilities(): string[] {
  return Object.entries(new OpenFxBackend().capabilities())
    .filter(
      ([, value]) =>
        value === false || (Array.isArray(value) && value.length === 0),
    )
    .map(([key]) => key);
}

describe("OpenFxProviderSection", () => {
  test("names every capability OpenFX does not support", async () => {
    const { OPENFX_LIMITATIONS } = await modulePromise;

    expect(
      new Set(OPENFX_LIMITATIONS.map((entry) => entry.capability)),
    ).toEqual(new Set(unsupportedCapabilities()));
  });

  test("every limitation says something a reader can act on", async () => {
    const { OPENFX_LIMITATIONS } = await modulePromise;

    for (const entry of OPENFX_LIMITATIONS) {
      expect(entry.text.length).toBeGreaterThan(20);
    }
  });
});
