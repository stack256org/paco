import { describe, expect, test } from "bun:test";
import { parsePluginManifest, pluginManifestSchema } from "./manifest.ts";

function minimalManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: "my-plugin",
    version: "1.0.0",
    description: "Does a thing.",
    pacoApi: 1,
    ...overrides,
  };
}

describe("pluginManifestSchema", () => {
  test("parses a valid minimal manifest", () => {
    const result = pluginManifestSchema.safeParse(minimalManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  describe("name", () => {
    test("rejects uppercase characters", () => {
      const result = pluginManifestSchema.safeParse(
        minimalManifest({ name: "My-Plugin" }),
      );
      expect(result.success).toBe(false);
    });

    test("rejects a leading digit", () => {
      const result = pluginManifestSchema.safeParse(
        minimalManifest({ name: "1plugin" }),
      );
      expect(result.success).toBe(false);
    });

    test("rejects names longer than 64 characters", () => {
      const longName = `a${"b".repeat(64)}`;
      expect(longName.length).toBe(65);
      const result = pluginManifestSchema.safeParse(
        minimalManifest({ name: longName }),
      );
      expect(result.success).toBe(false);
    });
  });

  test("rejects pacoApi: 2", () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ pacoApi: 2 }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects "net:fetch" without netDomains, naming the rule', () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ capabilities: ["net:fetch"] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join("\n");
      expect(message).toContain(
        '"net:fetch" requires a non-empty netDomains list',
      );
    }
  });

  test('rejects "net:fetch" with an empty netDomains list', () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ capabilities: ["net:fetch"], netDomains: [] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join("\n");
      expect(message).toContain(
        '"net:fetch" requires a non-empty netDomains list',
      );
    }
  });

  test("accepts net:fetch with a non-empty netDomains list", () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({
        capabilities: ["net:fetch"],
        netDomains: ["api.example.com"],
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects netDomains present without net:fetch", () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ netDomains: ["api.example.com"] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join("\n");
      expect(message).toContain("netDomains");
      expect(message).toContain('"net:fetch"');
    }
  });

  test("rejects mcpServers without tools:register", () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({
        mcpServers: {
          example: { command: "node", args: [], env: {} },
        },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join("\n");
      expect(message).toContain("mcpServers");
      expect(message).toContain('"tools:register"');
    }
  });

  test("accepts mcpServers with tools:register", () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({
        capabilities: ["tools:register"],
        mcpServers: {
          example: { command: "node", args: ["server.js"], env: {} },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test('accepts "tasks:create" on its own, with no companion field required', () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ capabilities: ["tasks:create"] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual(["tasks:create"]);
    }
  });
});

describe("parsePluginManifest", () => {
  test("returns ok:true with the parsed manifest for valid input", () => {
    const result = parsePluginManifest(minimalManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("my-plugin");
    }
  });

  test("returns ok:false with an error string, never throws, for garbage input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "not an object",
      [],
      {},
      { name: "bad plugin" },
    ];
    for (const input of inputs) {
      const result = parsePluginManifest(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error).toBe("string");
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
  });

  test("returns ok:false for a non-object primitive without throwing", () => {
    expect(() => parsePluginManifest("garbage")).not.toThrow();
    expect(() => parsePluginManifest(123)).not.toThrow();
    expect(() => parsePluginManifest(null)).not.toThrow();
  });
});
