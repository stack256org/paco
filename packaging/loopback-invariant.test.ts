import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One invariant, asserted in every place that can break it:
 *
 *   **Nothing this package starts may listen on a non-loopback address.**
 *
 * nginx is the only process that binds a public interface, and nginx is the
 * only thing holding the instance password. Anything else that binds `0.0.0.0`
 * is reachable without that password, and Paco has no other gate — there is no
 * sign-in behind it any more.
 *
 * This file exists because that invariant was broken three separate times, in
 * three different layers, each by omission rather than intent:
 *
 *   1. The Next server bound `0.0.0.0:3000` — its standalone entrypoint
 *      defaults to that when `HOSTNAME` is unset, and nothing set it.
 *   2. Sandbox containers published their dev-server ports on `0.0.0.0` —
 *      Docker's default when `HostIp` is omitted, and it was omitted.
 *   3. The internal approval and plugin-tool callbacks derived their port from
 *      the PUBLIC origin, so on a real domain they resolved to `127.0.0.1:80`
 *      — nginx — and were rejected by the very password they should never have
 *      met.
 *
 * Each was invisible to the type-checker and to every behavioural test, because
 * each is a *default* rather than a statement. The assertions below are
 * deliberately about the absence of a default: they check that the binding is
 * stated explicitly, not merely that it happens to be right today.
 *
 * These read the packaging files as text. There is no Debian host here to run
 * them against, so this is a regression guard, not proof — the real check is
 * `ss -ltnp` on a real install, which `docs/self-hosting.md` asks for.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

function repoFile(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

describe("the app process binds loopback only", () => {
  test("paco.service sets HOSTNAME in [Service], where systemd reads it", async () => {
    const unit = await readFile(repoFile("packaging", "paco.service"), "utf8");

    // An `Environment=` line in [Unit] or [Install] is silently ignored by
    // systemd — it would look correct in a diff and do nothing at all.
    const service = unit.slice(unit.indexOf("[Service]"));
    const install = service.indexOf("[Install]");
    const serviceSection = install === -1 ? service : service.slice(0, install);

    expect(serviceSection).toContain("Environment=HOSTNAME=127.0.0.1");
  });

  test("postinst writes HOSTNAME into the generated paco.env", async () => {
    const postinst = await readFile(
      repoFile("packaging", "debian", "postinst"),
      "utf8",
    );

    // paco.service repairs existing installs on upgrade; this covers a fresh
    // one, and documents the intent where an operator will look for it.
    expect(postinst).toContain("HOSTNAME=127.0.0.1");
  });
});

describe("sandbox containers publish on loopback only", () => {
  test("port bindings state HostIp explicitly", async () => {
    const sandbox = await readFile(
      repoFile("packages", "sandbox", "docker", "sandbox.ts"),
      "utf8",
    );

    expect(sandbox).toContain('HostIp: "127.0.0.1"');
  });

  test("no HostPort is published without a HostIp beside it", async () => {
    const sandbox = await readFile(
      repoFile("packages", "sandbox", "docker", "sandbox.ts"),
      "utf8",
    );

    // The original bug was `[{ HostPort: "0" }]` — correct-looking, and
    // published on every interface because Docker fills the omission with
    // 0.0.0.0. Catch the shape, not just the absence of a literal.
    const bindingsWithoutHost = sandbox.match(/\{\s*HostPort:/g) ?? [];
    expect(bindingsWithoutHost).toHaveLength(0);
  });
});

describe("internal callbacks bypass nginx", () => {
  test("no internal URL derives its port from the public origin", async () => {
    const files = [
      repoFile("apps", "web", "app", "workflows", "chat.ts"),
      repoFile("apps", "web", "lib", "tasks", "reviewer-gate.ts"),
      repoFile("apps", "web", "lib", "agent", "chat-environment.ts"),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");

      // `appUrl().port` is the PUBLIC origin's port. On https://example.com it
      // is empty, so `|| "80"` sent these straight into nginx and its password.
      expect(source).not.toContain("appUrl().port");
    }
  });

  test("the loopback helper honours PORT rather than hardcoding one", async () => {
    const appUrl = await readFile(
      repoFile("apps", "web", "lib", "app-url.ts"),
      "utf8",
    );

    expect(appUrl).toContain("appLoopbackUrl");
    expect(appUrl).toContain("process.env.PORT");
  });
});
