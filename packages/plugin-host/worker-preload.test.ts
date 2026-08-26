import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { readdirSync } from "node:fs";
import { workerPreloadPath } from "./host.ts";

/**
 * Reconnaissance surface on `process` itself.
 *
 * `host.test.ts` covers the module allowlist — both routes to a builtin, 24
 * escape probes, all closed. This file covers the OTHER surface the preload
 * has to hold: members of the `process` object, which no module resolution
 * and no permission model ever sees.
 *
 * The motivating hole was `process.report`. `worker-preload.ts` excludes the
 * `os` builtin on purpose, because `os.networkInterfaces()` and
 * `os.userInfo()` are "pure reconnaissance" that could later leave through a
 * granted `net:fetch` domain — but `process.report.getReport()` returned
 * `header.networkInterfaces` (every host IP and MAC), `header.host` (the
 * machine's hostname), `header.commandLine` (which spells out the
 * `--allow-fs-read` prefixes, i.e. a map of what this worker may read),
 * `environmentVariables`, and several hundred `sharedObjects` filesystem
 * paths. Same class of leak, reached without importing anything.
 *
 * These probes run against the REAL preload, in a real Node with
 * `--permission`, exactly as a plugin worker runs.
 */

interface NodeCandidate {
  path: string;
  version: string;
  major: number;
}

/**
 * A Node that supports `--permission` and the synchronous
 * `module.registerHooks` (>= 22.15) the preload is built on. Mirrors the
 * discovery in `host.test.ts` so the same binaries are found.
 */
function probeNode(candidate: string): NodeCandidate | undefined {
  try {
    const version = execFileSync(
      candidate,
      ["--permission", "-e", "process.stdout.write(process.versions.node)"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major > 22 || (major === 22 && minor >= 15)) {
      return { path: candidate, version, major };
    }
  } catch {
    // Not a usable Node.
  }
  return undefined;
}

function nodeCandidatePaths(): string[] {
  const candidates = new Set<string>();
  if (process.env.PACO_NODE_EXECUTABLE) {
    candidates.add(process.env.PACO_NODE_EXECUTABLE);
  }
  for (const fixed of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    candidates.add(fixed);
  }
  try {
    const onPath = execFileSync("/usr/bin/env", ["which", "node"], {
      encoding: "utf-8",
    }).trim();
    if (onPath) {
      candidates.add(onPath);
    }
  } catch {
    // No node on PATH.
  }
  const home = homedir();
  for (const root of [
    path.join(home, ".nvm/versions/node"),
    path.join(
      home,
      "Library/Application Support/Herd/config/nvm/versions/node",
    ),
    path.join(home, ".local/share/fnm/node-versions"),
    path.join(home, ".volta/tools/image/node"),
    path.join(home, ".asdf/installs/nodejs"),
  ]) {
    try {
      for (const entry of readdirSync(root)) {
        candidates.add(path.join(root, entry, "bin", "node"));
        candidates.add(path.join(root, entry, "installation", "bin", "node"));
      }
    } catch {
      // Version manager not installed.
    }
  }
  return [...candidates];
}

const probedNodes = nodeCandidatePaths()
  .map(probeNode)
  .filter((candidate): candidate is NodeCandidate => candidate !== undefined);

function newest(candidates: NodeCandidate[]): NodeCandidate | undefined {
  return candidates.sort((a, b) => b.major - a.major)[0];
}

const legacyNode = newest(probedNodes.filter((node) => node.major === 22));
const modernNode = newest(probedNodes.filter((node) => node.major >= 24));

function runProbe(node: NodeCandidate, script: string): Record<string, string> {
  // Realpath'd: on macOS `/tmp` is a symlink to `/private/tmp`, and the
  // permission model matches on the real path.
  const probeDir = realpathSync(
    mkdtempSync(path.join(realpathSync(tmpdir()), "preload-process-")),
  );
  try {
    const probeFile = path.join(probeDir, "probe.mjs");
    writeFileSync(probeFile, script);
    const stdout = execFileSync(
      node.path,
      [
        "--permission",
        `--allow-fs-read=${path.join(probeDir, "*")}`,
        `--allow-fs-read=${path.join(realpathSync(import.meta.dirname), "*")}`,
        "--import",
        realpathSync(workerPreloadPath),
        probeFile,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(lastLine) as Record<string, string>;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * Every probe reports the string "denied" when the guard held, and something
 * else — always carrying the leaked value — when it did not, so a failure
 * message names what actually escaped rather than just `false`.
 */
const PROBE_SCRIPT = String.raw`
const out = {};

function probe(name, fn) {
  try {
    out[name] = "LEAKED:" + String(fn()).slice(0, 60);
  } catch {
    out[name] = "denied";
  }
}

// --- process.report: the whole object is reconnaissance. ---
probe("report.getReport", () => JSON.stringify(process.report.getReport().header.networkInterfaces).slice(0, 40));
probe("report.host", () => process.report.getReport().header.host);
probe("report.commandLine", () => process.report.getReport().header.commandLine);
probe("report.sharedObjects", () => process.report.getReport().sharedObjects.length);
probe("report.environmentVariables", () => Object.keys(process.report.getReport().environmentVariables).length);
probe("report.writeReport", () => process.report.writeReport());
probe("report.directory", () => "directory=" + process.report.directory);
out["report.typeof"] = typeof process.report;

// --- The uid/gid family: os.userInfo() by another name. ---
for (const name of ["getuid", "getgid", "geteuid", "getegid", "getgroups"]) {
  probe("process." + name, () => process[name]());
}
for (const name of ["setuid", "setgid", "seteuid", "setegid", "setgroups", "initgroups"]) {
  probe("process." + name, () => process[name](0));
}

// --- Underscore internals that hand out live handle objects. ---
probe("process._getActiveHandles", () => process._getActiveHandles().length);
probe("process._getActiveRequests", () => process._getActiveRequests().length);

// --- Native addon loading. ---
probe("process.dlopen", () => process.dlopen({ exports: {} }, "/nonexistent.node"));

// --- The map of what this worker may read. ---
out["process.execArgv"] = process.execArgv.length === 0
  ? "denied"
  : "LEAKED:" + process.execArgv.join(" ").slice(0, 60);

// --- Guards that were already in place; they must stay closed. ---
probe("process.binding", () => process.binding("tcp_wrap"));
probe("process.getBuiltinModule(net)", () => process.getBuiltinModule("node:net"));

// --- The baseline the worker itself needs. Locking must not break these. ---
out["ok.getBuiltinModule(path)"] = typeof process.getBuiltinModule("node:path").join;
out["ok.import(fs)"] = typeof (await import("node:fs")).readFileSync;
out["ok.stdout"] = typeof process.stdout.write;
out["ok.env"] = typeof process.env;
out["ok.exit"] = typeof process.exit;
out["ok.on"] = typeof process.on;
out["ok.cwd"] = typeof process.cwd();

console.log(JSON.stringify(out));
`;

const DENIED_KEYS = [
  "report.getReport",
  "report.host",
  "report.commandLine",
  "report.sharedObjects",
  "report.environmentVariables",
  "report.writeReport",
  "report.directory",
  "process.getuid",
  "process.getgid",
  "process.geteuid",
  "process.getegid",
  "process.getgroups",
  "process.setuid",
  "process.setgid",
  "process.seteuid",
  "process.setegid",
  "process.setgroups",
  "process.initgroups",
  "process._getActiveHandles",
  "process._getActiveRequests",
  "process.dlopen",
  "process.execArgv",
  "process.binding",
  "process.getBuiltinModule(net)",
];

function describeProcessSurface(label: string, node: NodeCandidate): void {
  describe(`worker preload: process surface (${label}, Node ${node.version})`, () => {
    test("leaks nothing in the class the `os` exclusion exists to prevent", () => {
      const result = runProbe(node, PROBE_SCRIPT);

      for (const key of DENIED_KEYS) {
        expect(`${key} => ${result[key]}`).toBe(`${key} => denied`);
      }
      expect(result["report.typeof"]).toBe("undefined");
    });

    test("still leaves the worker everything it legitimately needs", () => {
      const result = runProbe(node, PROBE_SCRIPT);

      expect(result["ok.getBuiltinModule(path)"]).toBe("function");
      expect(result["ok.import(fs)"]).toBe("function");
      expect(result["ok.stdout"]).toBe("function");
      expect(result["ok.env"]).toBe("object");
      expect(result["ok.exit"]).toBe("function");
      expect(result["ok.on"]).toBe("function");
      expect(result["ok.cwd"]).toBe("string");
    });
  });
}

if (legacyNode) {
  describeProcessSurface("Node 22.x", legacyNode);
}
if (modernNode) {
  describeProcessSurface("Node >= 24", modernNode);
}
if (!(legacyNode || modernNode)) {
  test.skip("no Node with --permission was found; process-surface probes skipped", () => {
    // Intentionally empty: reported by the skip itself.
  });
}
