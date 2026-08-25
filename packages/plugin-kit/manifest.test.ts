import { describe, expect, test } from "bun:test";
import {
  channelAuthMode,
  channelSlotKey,
  checkChannelDeclarations,
  checkChannelsCapability,
  parsePluginManifest,
  pluginManifestSchema,
} from "./manifest.ts";

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

  test('accepts "channels:ingress" on its own, with no companion field required', () => {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ capabilities: ["channels:ingress"] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual(["channels:ingress"]);
    }
  });
});

describe("checkChannelsCapability", () => {
  function parsedManifest(capabilities: string[] = []) {
    const result = pluginManifestSchema.safeParse(
      minimalManifest({ capabilities }),
    );
    if (!result.success) {
      throw new Error(result.error.message);
    }
    return result.data;
  }

  test("returns undefined when there is no channels/ slot", () => {
    expect(checkChannelsCapability(parsedManifest([]), [])).toBeUndefined();
  });

  test("returns undefined when a channels/ slot is paired with channels:ingress", () => {
    expect(
      checkChannelsCapability(parsedManifest(["channels:ingress"]), [
        "/plugin/channels/events.ts",
      ]),
    ).toBeUndefined();
  });

  test('names the rule when a channels/ slot exists without "channels:ingress"', () => {
    const error = checkChannelsCapability(parsedManifest([]), [
      "/plugin/channels/events.ts",
    ]);
    expect(error).toContain("channels/");
    expect(error).toContain('"channels:ingress"');
  });

  test("is unaffected by unrelated capabilities", () => {
    const error = checkChannelsCapability(parsedManifest(["storage:kv"]), [
      "/plugin/channels/events.ts",
    ]);
    expect(error).toContain('"channels:ingress"');
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

describe("channelSlotKey", () => {
  test("is a slot file's basename without its extension", () => {
    expect(channelSlotKey("/plugins/slack/channels/events.ts")).toBe("events");
    expect(channelSlotKey("/plugins/slack/channels/events.js")).toBe("events");
    expect(channelSlotKey("channels/events.ts")).toBe("events");
  });

  test("handles Windows-style separators and a bare filename", () => {
    expect(channelSlotKey("C:\\plugins\\slack\\channels\\events.ts")).toBe(
      "events",
    );
    expect(channelSlotKey("events.ts")).toBe("events");
  });

  test("leaves a dotted name that is not a .ts/.js extension alone", () => {
    expect(channelSlotKey("channels/events.v2.ts")).toBe("events.v2");
  });
});

describe("channel auth declarations", () => {
  test("an undeclared channel defaults to shared-secret", () => {
    const result = parsePluginManifest(minimalManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(channelAuthMode(result.manifest, "events")).toBe("shared-secret");
    }
  });

  test("a declared channel gets the mode it declares", () => {
    const result = parsePluginManifest(
      minimalManifest({
        channels: [
          { name: "events", auth: "self-verified" },
          { name: "commands", auth: "shared-secret" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(channelAuthMode(result.manifest, "events")).toBe("self-verified");
      expect(channelAuthMode(result.manifest, "commands")).toBe(
        "shared-secret",
      );
      // A sibling declaration must not leak onto an unnamed channel.
      expect(channelAuthMode(result.manifest, "other")).toBe("shared-secret");
    }
  });

  test("rejects an unknown auth mode rather than silently defaulting", () => {
    const result = parsePluginManifest(
      minimalManifest({ channels: [{ name: "events", auth: "none" }] }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a duplicate channel declaration", () => {
    const result = parsePluginManifest(
      minimalManifest({
        channels: [
          { name: "events", auth: "self-verified" },
          { name: "events", auth: "shared-secret" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("duplicate channel declaration");
    }
  });
});

describe("checkChannelDeclarations", () => {
  function manifestWith(channels: unknown) {
    const result = parsePluginManifest(minimalManifest({ channels }));
    if (!result.ok) {
      throw new Error(`fixture manifest did not parse: ${result.error}`);
    }
    return result.manifest;
  }

  test("accepts declarations that all have a matching slot file", () => {
    const manifest = manifestWith([
      { name: "events", auth: "self-verified" },
      { name: "commands", auth: "shared-secret" },
    ]);
    expect(
      checkChannelDeclarations(manifest, ["events", "commands"]),
    ).toBeUndefined();
  });

  test("rejects a declaration with no matching slot file", () => {
    // Declaring self-verified for a channel that does not exist would
    // otherwise be a silent no-op, and the operator would have consented to
    // an unauthenticated ingress path that never appears.
    const manifest = manifestWith([{ name: "typo", auth: "self-verified" }]);
    const error = checkChannelDeclarations(manifest, ["events"]);
    expect(error).toContain("typo");
  });

  test("accepts a slot file with no declaration, which defaults to shared-secret", () => {
    const manifest = manifestWith([{ name: "events", auth: "self-verified" }]);
    expect(
      checkChannelDeclarations(manifest, ["events", "undeclared"]),
    ).toBeUndefined();
    expect(channelAuthMode(manifest, "undeclared")).toBe("shared-secret");
  });

  test("accepts a manifest that declares no channels at all", () => {
    const result = parsePluginManifest(minimalManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(checkChannelDeclarations(result.manifest, [])).toBeUndefined();
      expect(
        checkChannelDeclarations(result.manifest, ["events"]),
      ).toBeUndefined();
    }
  });
});
