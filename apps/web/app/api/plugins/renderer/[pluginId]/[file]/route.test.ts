import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type StubPluginRow = { id: string; enabled: boolean };

let pluginRows: Map<string, StubPluginRow>;

mock.module("@/lib/db/plugins", () => ({
  getPlugin: async (id: string) => pluginRows.get(id),
  // Unused by this route — stubbed only because `@/lib/plugins/install`
  // (imported for `pluginDir`) imports it from the same module, and
  // `mock.module` replaces the whole module rather than patching one export.
  upsertPlugin: async () => {
    // no-op
  },
}));

/** A signed-in session by default; a test can set this to `undefined`. */
let currentSession: { user: { id: string } } | undefined;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
}));

const { GET } = await import("./route");

let pluginsRoot: string;

beforeEach(async () => {
  pluginsRoot = await mkdtemp(path.join(os.tmpdir(), "paco-plugin-renderer-"));
  process.env.PACO_PLUGINS_DIR = pluginsRoot;
  pluginRows = new Map();
  currentSession = { user: { id: "user-1" } };
});

afterEach(async () => {
  delete process.env.PACO_PLUGINS_DIR;
  await rm(pluginsRoot, { recursive: true, force: true });
});

/** Creates `<pluginsRoot>/<pluginId>/renderers/<file>` with `contents`. */
async function writeRenderer(
  pluginId: string,
  file: string,
  contents: string,
): Promise<void> {
  const dir = path.join(pluginsRoot, pluginId, "renderers");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
}

function getRequest(pluginId: string, file: string): Request {
  const url = `http://localhost/api/plugins/renderer/${encodeURIComponent(pluginId)}/${encodeURIComponent(file)}`;
  return new Request(url);
}

function callRoute(pluginId: string, file: string) {
  return GET(getRequest(pluginId, file), {
    params: Promise.resolve({ pluginId, file }),
  });
}

describe("GET /api/plugins/renderer/[pluginId]/[file]", () => {
  test("serves an enabled plugin's renderer with the exact CSP and content-type", async () => {
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    await writeRenderer(
      "demo-plugin",
      "search.html",
      "<!doctype html><body>hi</body>",
    );

    const response = await callRoute("demo-plugin", "search.html");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await response.text()).toBe("<!doctype html><body>hi</body>");
  });

  test("401s an unauthenticated request before any plugin/fs lookup", async () => {
    currentSession = undefined;
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    await writeRenderer("demo-plugin", "search.html", "<body>hi</body>");

    const response = await callRoute("demo-plugin", "search.html");
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBeTruthy();
  });

  test("404s for a plugin id with no matching row", async () => {
    const response = await callRoute("unknown-plugin", "search.html");
    expect(response.status).toBe(404);
  });

  test("404s for a disabled plugin, even though its renderer file exists", async () => {
    pluginRows.set("disabled-plugin", {
      id: "disabled-plugin",
      enabled: false,
    });
    await writeRenderer("disabled-plugin", "search.html", "<body>hi</body>");

    const response = await callRoute("disabled-plugin", "search.html");
    expect(response.status).toBe(404);
  });

  test("404s for a renderer file that doesn't exist", async () => {
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    await mkdir(path.join(pluginsRoot, "demo-plugin", "renderers"), {
      recursive: true,
    });

    const response = await callRoute("demo-plugin", "missing.html");
    expect(response.status).toBe(404);
  });

  test("rejects a path-traversal file segment before any fs call", async () => {
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    // Outside the plugin tree entirely, so a successful traversal would
    // read it.
    const secretPath = path.join(pluginsRoot, "secret.txt");
    await writeFile(secretPath, "top secret");

    const response = await callRoute("demo-plugin", "..%2f..%2fsecret.txt");
    expect(response.status).toBe(404);

    const response2 = await callRoute("demo-plugin", "../../secret.txt");
    expect(response2.status).toBe(404);
  });

  test("rejects a path-traversal plugin-id segment before any fs call", async () => {
    const response = await callRoute("..%2f..%2fetc", "passwd.html");
    expect(response.status).toBe(404);

    const response2 = await callRoute("../../etc", "passwd.html");
    expect(response2.status).toBe(404);
  });

  test("rejects a symlinked renderer file, even one pointing inside the same directory", async () => {
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    await writeRenderer("demo-plugin", "legit.html", "<body>legit</body>");
    const renderersDir = path.join(pluginsRoot, "demo-plugin", "renderers");
    await symlink(
      path.join(renderersDir, "legit.html"),
      path.join(renderersDir, "evil.html"),
    );

    const response = await callRoute("demo-plugin", "evil.html");
    expect(response.status).toBe(404);
  });

  test("rejects a symlinked renderer file pointing outside the plugin's tree", async () => {
    pluginRows.set("demo-plugin", { id: "demo-plugin", enabled: true });
    const renderersDir = path.join(pluginsRoot, "demo-plugin", "renderers");
    await mkdir(renderersDir, { recursive: true });
    const secretPath = path.join(pluginsRoot, "secret.html");
    await writeFile(secretPath, "top secret");
    await symlink(secretPath, path.join(renderersDir, "escape.html"));

    const response = await callRoute("demo-plugin", "escape.html");
    expect(response.status).toBe(404);
  });
});
