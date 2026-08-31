import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

mock.module("server-only", () => ({}));

const organization = { id: "org-1" };
mock.module("@/lib/org/organization", () => ({
  getOrganization: () => Promise.resolve(organization),
}));

const { promoteMemoryAction } = await import("./promote");
// The writer itself is imported from the ordinary module it now lives in —
// `promote.ts` must not export it (see the structural tests at the bottom).
const { promoteToOrgMemory } = await import("./org-writer");
const { orgMemoryDir } = await import("./paths");
const { listMemory } = await import("./store");

let dataDir: string;
let originalPacoHome: string | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-promote-test-"));
  originalPacoHome = process.env.PACO_HOME;
  process.env.PACO_HOME = dataDir;
});

afterEach(async () => {
  if (originalPacoHome === undefined) {
    delete process.env.PACO_HOME;
  } else {
    process.env.PACO_HOME = originalPacoHome;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("promoteToOrgMemory", () => {
  test("writes an entry tagged source 'promoted'", async () => {
    const { slug } = await promoteToOrgMemory({
      organizationId: "org-1",
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe(slug);
    expect(entries[0]?.source).toBe("promoted");
    expect(entries[0]?.body).toBe("Always deploy from main.");
  });
});

describe("promoteMemoryAction", () => {
  test("a proposal writes org memory directly", async () => {
    const result = await promoteMemoryAction({
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    expect(result).toEqual({
      ok: true,
      promoted: true,
      slug: "deploy-convention",
    });
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(1);
  });
});

/**
 * The regression that matters most here is not behavioural, it is structural.
 *
 * In Next.js every exported async function in a `"use server"` module is
 * given a POST-able action id, and this module is imported by a client
 * component (`app/settings/memory/memory-page-content.tsx`), so those ids
 * ship to the browser. An *ungated* exported writer is therefore a public
 * endpoint that writes attacker-chosen content into org-shared memory —
 * which `lib/memory/load-for-turn.ts` injects into agent turns.
 *
 * So the writer must not live in a `"use server"` module at all. These two
 * tests read the source rather than the exports because that is exactly what
 * the Next.js compiler does: the danger is the *shape of the module*, not
 * anything observable by calling it.
 */
describe("the server-action surface of lib/memory", () => {
  test("promote.ts exports the gated action and nothing else", async () => {
    const source = await fs.readFile(
      new URL("promote.ts", import.meta.url),
      "utf8",
    );

    expect(source.trimStart().startsWith('"use server"')).toBe(true);

    const exportedFunctions = [
      ...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm),
    ].map((match) => match[1]);

    expect(exportedFunctions).toEqual(["promoteMemoryAction"]);
  });

  test("the org-memory writer lives in a module that is not a server-action module", async () => {
    const source = await fs.readFile(
      new URL("org-writer.ts", import.meta.url),
      "utf8",
    );

    // A directive is a statement, so it can only be a line that *starts*
    // with the string literal. The docstring in that file discusses
    // `"use server"` at length; that must not read as one.
    expect(/^\s*["']use server["']/m.test(source)).toBe(false);
    expect(source).toContain("export async function promoteToOrgMemory");
  });
});
