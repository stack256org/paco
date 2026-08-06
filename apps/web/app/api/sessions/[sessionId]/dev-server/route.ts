import path from "node:path";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import {
  makeRuntimeDir,
  readRuntimeFile,
  writeRuntimeFile,
} from "@/lib/sandbox/runtime-files";
import { stopProcessGroup } from "@/lib/sandbox/process-control";
import { connectSandbox } from "@paco/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSessionWithSandboxGuard,
} from "@/app/api/sessions/_lib/session-context";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import { isSandboxActive } from "@/lib/sandbox/utils";
import {
  DEV_SERVER_LOG_TAIL_LINES,
  summarizeDevServerLog,
} from "./_lib/dev-server-log";
import {
  fallbackCandidates,
  NO_PACKAGE_MANAGER_MESSAGE,
  type PackageManagerName,
  selectAvailablePackageManager,
} from "./_lib/package-manager-fallback";

const WORKSPACE_ASLEEP_DEV_SERVER =
  "This workspace is asleep. Choose Resume to wake it, then start the dev server.";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export type DevServerLaunchResponse = {
  packagePath: string;
  port: number;
  url: string;
};

export type DevServerStopResponse = {
  stopped: boolean;
  packagePath: string;
  port: number;
};

// Aliased rather than redeclared: the fallback table is keyed by this union, so
// a manager added in one place and not the other must not type-check.
type PackageManager = PackageManagerName;
type DevFramework =
  | "next"
  | "vite"
  | "astro"
  | "react-scripts"
  | "remix"
  | "nuxt"
  | "custom";

type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;

interface PackageManifest {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DevServerCandidate {
  packagePath: string;
  packageDir: string;
  port: number;
  script: string;
  framework: DevFramework;
  score: number;
  packageManagerField?: string;
}

interface ResolvedDevServerTarget {
  packagePath: string;
  packageDir: string;
  packageDirAbs: string;
  port: number;
}

interface LaunchableDevServerTarget extends ResolvedDevServerTarget {
  candidate: DevServerCandidate;
}

interface PersistedDevServerTarget {
  packageDir: string;
  port: number;
}

const SUPPORTED_PORTS = new Set(DEFAULT_SANDBOX_PORTS);
const DEV_SERVER_PIDFILE_PREFIX = ".paco-dev-server";
const DEV_SERVER_STATE_FILENAME = `${DEV_SERVER_PIDFILE_PREFIX}-state.json`;
const INSTALL_COMMANDS: Record<PackageManager, string> = {
  bun: "bun install",
  pnpm: "pnpm install",
  yarn: "yarn install",
  npm: "npm install",
};
const PACKAGE_MANAGER_LOCKFILES: Array<{
  manager: PackageManager;
  files: string[];
}> = [
  { manager: "bun", files: ["bun.lockb", "bun.lock"] },
  { manager: "pnpm", files: ["pnpm-lock.yaml", "pnpm-workspace.yaml"] },
  { manager: "yarn", files: ["yarn.lock"] },
  { manager: "npm", files: ["package-lock.json"] },
];
const PACKAGE_JSON_FIND_COMMAND =
  "find . \\( -path '*/node_modules/*' -o -path '*/.git/*' -o -path '*/.next/*' -o -path '*/dist/*' -o -path '*/build/*' -o -path '*/coverage/*' -o -path '*/.turbo/*' \\) -prune -o -name package.json -print | sort";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseManifest(content: string): PackageManifest | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      packageManager:
        typeof parsed.packageManager === "string"
          ? parsed.packageManager
          : undefined,
      scripts: toStringRecord(parsed.scripts),
      dependencies: toStringRecord(parsed.dependencies),
      devDependencies: toStringRecord(parsed.devDependencies),
    };
  } catch {
    return null;
  }
}

function normalizePackageJsonPath(packageJsonPath: string): string {
  return packageJsonPath.replace(/^\.\//, "");
}

function normalizePackageDir(packageJsonPath: string): string {
  const packageDir = path.posix.dirname(packageJsonPath);
  return packageDir === "." ? "." : packageDir;
}

function formatPackagePath(packageDir: string): string {
  return packageDir === "." ? "root" : packageDir;
}

function resolvePackageDirAbs(
  workingDirectory: string,
  packageDir: string,
): string {
  return packageDir === "."
    ? workingDirectory
    : path.posix.join(workingDirectory, packageDir);
}

function buildResolvedDevServerTarget(params: {
  workingDirectory: string;
  packageDir: string;
  port: number;
}): ResolvedDevServerTarget {
  return {
    packagePath: formatPackagePath(params.packageDir),
    packageDir: params.packageDir,
    packageDirAbs: resolvePackageDirAbs(
      params.workingDirectory,
      params.packageDir,
    ),
    port: params.port,
  };
}

function toLaunchableDevServerTarget(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
  candidate: DevServerCandidate,
): LaunchableDevServerTarget {
  return {
    ...buildResolvedDevServerTarget({
      workingDirectory,
      packageDir: candidate.packageDir,
      port: candidate.port,
    }),
    candidate,
  };
}

function isValidPersistedPackageDir(packageDir: string): boolean {
  if (packageDir === ".") {
    return true;
  }

  if (packageDir.length === 0 || path.posix.isAbsolute(packageDir)) {
    return false;
  }

  const normalizedPackageDir = path.posix.normalize(packageDir);
  return (
    normalizedPackageDir === packageDir &&
    normalizedPackageDir !== "." &&
    normalizedPackageDir !== ".." &&
    !normalizedPackageDir.startsWith("../")
  );
}

function parsePersistedDevServerTarget(
  content: string,
): PersistedDevServerTarget | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const packageDir =
      typeof parsed.packageDir === "string" ? parsed.packageDir : null;
    const port = toSupportedPort(
      typeof parsed.port === "number" && Number.isInteger(parsed.port)
        ? parsed.port
        : null,
    );

    if (
      !packageDir ||
      port === null ||
      !isValidPersistedPackageDir(packageDir)
    ) {
      return null;
    }

    return {
      packageDir,
      port,
    };
  } catch {
    return null;
  }
}

function extractExplicitPort(script: string): number | null {
  const patterns = [
    /--port(?:=|\s+)(\d{2,5})/i,
    /(?:^|\s)-p(?:=|\s+)(\d{2,5})(?=$|\s)/i,
    /\bPORT=(\d{2,5})\b/i,
  ];

  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function getDependencyNames(manifest: PackageManifest): Set<string> {
  return new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

function detectFramework(
  manifest: PackageManifest,
  script: string,
): DevFramework {
  const normalizedScript = script.toLowerCase();
  const dependencyNames = getDependencyNames(manifest);

  if (normalizedScript.includes("next dev") || dependencyNames.has("next")) {
    return "next";
  }

  if (normalizedScript.includes("astro") || dependencyNames.has("astro")) {
    return "astro";
  }

  if (
    normalizedScript.includes("vite") ||
    dependencyNames.has("vite") ||
    dependencyNames.has("@sveltejs/kit")
  ) {
    return "vite";
  }

  if (
    normalizedScript.includes("react-scripts") ||
    dependencyNames.has("react-scripts")
  ) {
    return "react-scripts";
  }

  if (
    normalizedScript.includes("remix") ||
    dependencyNames.has("@remix-run/dev")
  ) {
    return "remix";
  }

  if (normalizedScript.includes("nuxt") || dependencyNames.has("nuxt")) {
    return "nuxt";
  }

  return "custom";
}

function getDefaultPortForFramework(framework: DevFramework): number | null {
  switch (framework) {
    case "next":
    case "react-scripts":
    case "remix":
    case "nuxt":
      return 3000;
    case "vite":
      return 5173;
    case "astro":
      return 4321;
    default:
      return null;
  }
}

function toSupportedPort(port: number | null | undefined): number | null {
  if (typeof port !== "number") {
    return null;
  }

  return SUPPORTED_PORTS.has(port) ? port : null;
}

function isWorkspaceOrchestratorScript(script: string): boolean {
  const normalized = script.toLowerCase();
  const patterns = [
    "turbo",
    " nx ",
    "nx ",
    "lerna",
    "concurrently",
    "npm-run-all",
    "wireit",
    "yarn workspaces",
    "pnpm -r",
    "pnpm --recursive",
    "npm -w",
    "npm --workspace",
  ];

  return patterns.some((pattern) => normalized.includes(pattern));
}

function scoreCandidate(candidate: {
  packageDir: string;
  framework: DevFramework;
  port: number;
  script: string;
}): number {
  let score = 0;

  if (candidate.framework !== "custom") {
    score += 100;
  }

  if (SUPPORTED_PORTS.has(candidate.port)) {
    score += 60;
  }

  if (candidate.packageDir.startsWith("apps/")) {
    score += 30;
  }

  if (candidate.packageDir.startsWith("app/")) {
    score += 20;
  }

  if (isWorkspaceOrchestratorScript(candidate.script)) {
    score -= 120;
  }

  if (candidate.packageDir === ".") {
    score -= 10;
  }

  return score - candidate.packageDir.split("/").length;
}

function buildCandidate(
  manifest: PackageManifest,
  packageJsonPath: string,
): DevServerCandidate | null {
  const script = manifest.scripts?.dev?.trim();
  if (!script) {
    return null;
  }

  const framework = detectFramework(manifest, script);
  const explicitPort = toSupportedPort(extractExplicitPort(script));
  const frameworkPort = toSupportedPort(getDefaultPortForFramework(framework));
  const port = explicitPort ?? frameworkPort;
  if (port === null) {
    return null;
  }

  const packageDir = normalizePackageDir(packageJsonPath);

  return {
    packagePath: formatPackagePath(packageDir),
    packageDir,
    port,
    script,
    framework,
    score: scoreCandidate({
      packageDir,
      framework,
      port,
      script,
    }),
    packageManagerField: manifest.packageManager,
  };
}

function pickBestCandidate(
  candidates: DevServerCandidate[],
): DevServerCandidate | null {
  const [candidate] = [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.packageDir.localeCompare(right.packageDir);
  });

  return candidate ?? null;
}

async function pathExists(
  sandbox: ConnectedSandbox,
  targetPath: string,
): Promise<boolean> {
  try {
    await sandbox.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getAncestorDirectories(startDir: string, stopDir: string): string[] {
  const directories: string[] = [];
  let currentDir = startDir;

  while (true) {
    directories.push(currentDir);

    if (currentDir === stopDir) {
      break;
    }

    const nextDir = path.posix.dirname(currentDir);
    if (nextDir === currentDir) {
      break;
    }

    currentDir = nextDir;
  }

  return directories;
}

function parsePackageManagerName(
  packageManagerField: string | undefined,
): PackageManager | null {
  if (!packageManagerField) {
    return null;
  }

  const [packageManagerName] = packageManagerField.split("@");
  switch (packageManagerName) {
    case "bun":
    case "pnpm":
    case "yarn":
    case "npm":
      return packageManagerName;
    default:
      return null;
  }
}

async function detectPackageManager(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
  packageDirAbs: string,
  packageManagerField: string | undefined,
): Promise<{ packageManager: PackageManager; installRootAbs: string }> {
  const ancestorDirectories = getAncestorDirectories(
    packageDirAbs,
    workingDirectory,
  );

  for (const directory of ancestorDirectories) {
    for (const entry of PACKAGE_MANAGER_LOCKFILES) {
      for (const lockfile of entry.files) {
        if (await pathExists(sandbox, path.posix.join(directory, lockfile))) {
          return {
            packageManager: entry.manager,
            installRootAbs: directory,
          };
        }
      }
    }
  }

  for (const directory of ancestorDirectories) {
    const packageJsonPath = path.posix.join(directory, "package.json");
    if (!(await pathExists(sandbox, packageJsonPath))) {
      continue;
    }

    const manifest = parseManifest(
      await sandbox.readFile(packageJsonPath, "utf-8"),
    );
    const packageManager = parsePackageManagerName(manifest?.packageManager);
    if (packageManager) {
      return {
        packageManager,
        installRootAbs: directory,
      };
    }
  }

  return {
    packageManager: parsePackageManagerName(packageManagerField) ?? "npm",
    installRootAbs: packageDirAbs,
  };
}

/**
 * Narrow the project's preferred package manager to one the container has.
 *
 * Asks the container directly rather than assuming what the image contains:
 * the image is rebuilt by whoever self-hosts Paco, so what is installed is not
 * a constant this code can know.
 */
async function resolveUsablePackageManager(
  sandbox: ConnectedSandbox,
  cwd: string,
  preferred: PackageManager,
): Promise<PackageManager | null> {
  const candidates = fallbackCandidates(preferred);
  const available = new Set<PackageManager>();

  for (const candidate of candidates) {
    const probe = await sandbox.exec(
      `command -v ${shellQuote(candidate)}`,
      cwd,
      10_000,
    );
    if (probe.success) {
      available.add(candidate);
    }
  }

  return selectAvailablePackageManager(preferred, (manager) =>
    available.has(manager),
  );
}

function getPackageManagerLockfiles(packageManager: PackageManager): string[] {
  return (
    PACKAGE_MANAGER_LOCKFILES.find((entry) => entry.manager === packageManager)
      ?.files ?? []
  );
}

async function getPathStat(sandbox: ConnectedSandbox, targetPath: string) {
  try {
    return await sandbox.stat(targetPath);
  } catch {
    return null;
  }
}

function getDependencyInputPaths(params: {
  packageDirAbs: string;
  installRootAbs: string;
  packageManager: PackageManager;
}): string[] {
  const dependencyInputPaths = new Set<string>();
  const ancestorDirectories = getAncestorDirectories(
    params.packageDirAbs,
    params.installRootAbs,
  );

  for (const directory of ancestorDirectories) {
    dependencyInputPaths.add(path.posix.join(directory, "package.json"));

    for (const lockfile of getPackageManagerLockfiles(params.packageManager)) {
      dependencyInputPaths.add(path.posix.join(directory, lockfile));
    }
  }

  return [...dependencyInputPaths];
}

async function shouldInstallDependencies(params: {
  sandbox: ConnectedSandbox;
  packageDirAbs: string;
  installRootAbs: string;
  packageManager: PackageManager;
}): Promise<boolean> {
  const nodeModulesStat = await getPathStat(
    params.sandbox,
    path.posix.join(params.installRootAbs, "node_modules"),
  );
  if (!nodeModulesStat?.isDirectory()) {
    return true;
  }

  for (const dependencyInputPath of getDependencyInputPaths(params)) {
    const dependencyInputStat = await getPathStat(
      params.sandbox,
      dependencyInputPath,
    );
    if (
      dependencyInputStat &&
      dependencyInputStat.mtimeMs > nodeModulesStat.mtimeMs
    ) {
      return true;
    }
  }

  return false;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function getFrameworkArgs(framework: DevFramework, port: number): string[] {
  switch (framework) {
    case "next":
      return ["--hostname", "0.0.0.0", "--port", String(port)];
    case "vite":
    case "astro":
    case "nuxt":
      return ["--host", "0.0.0.0", "--port", String(port)];
    default:
      return [];
  }
}

function buildRunCommand(
  packageManager: PackageManager,
  framework: DevFramework,
  port: number,
): string {
  const extraArgs = getFrameworkArgs(framework, port).join(" ");

  switch (packageManager) {
    case "bun":
      return `env BROWSER=none HOST=0.0.0.0 PORT=${port} bun run dev${extraArgs ? ` -- ${extraArgs}` : ""}`;
    /*
     * No `--` for pnpm, unlike npm.
     *
     * pnpm 11 stopped treating `--` as a separator and passes it to the script
     * verbatim, so `pnpm dev -- --host 0.0.0.0 --port 5173` ran
     * `vite -- --host 0.0.0.0 --port 5173`. Vite's parser takes everything
     * after `--` as positional, so it ignored both flags and bound to
     * localhost on its own default port — inside the container, where nothing
     * outside can reach it. The dev server appeared to start, Paco reported a
     * published URL, and the URL was dead.
     *
     * pnpm forwards unrecognised flags to the script on its own, so dropping
     * the separator is all that is needed.
     */
    case "pnpm":
      return `env BROWSER=none HOST=0.0.0.0 PORT=${port} pnpm dev${extraArgs ? ` ${extraArgs}` : ""}`;
    case "yarn":
      return `env BROWSER=none HOST=0.0.0.0 PORT=${port} yarn dev${extraArgs ? ` ${extraArgs}` : ""}`;
    case "npm":
      return `env BROWSER=none HOST=0.0.0.0 PORT=${port} npm run dev${extraArgs ? ` -- ${extraArgs}` : ""}`;
  }
}

/**
 * Where Paco keeps its dev-server bookkeeping.
 *
 * Under /tmp, not in the workspace. These files used to be written beside the
 * user's code, where they showed up in the Changes tab as
 * `.paco-dev-server-5173.pid` and `.paco-dev-server-state.json` — two files the
 * user did not write, listed among their own work, and staged by "Commit &
 * Push" straight into their repository.
 *
 * Keyed by the workspace path so two chats in one session cannot collide.
 */
function devServerRuntimeDir(packageDirAbs: string): string {
  const key = Buffer.from(packageDirAbs).toString("base64url");
  return path.posix.join("/tmp", "paco-dev-server", key);
}

function getDevServerPidFilePath(packageDirAbs: string, port: number): string {
  return path.posix.join(
    devServerRuntimeDir(packageDirAbs),
    `${DEV_SERVER_PIDFILE_PREFIX}-${port}.pid`,
  );
}

/**
 * Where this dev server's output goes.
 *
 * Beside the pid file, under /tmp, for the same reason: it is Paco's
 * bookkeeping, not the user's work, and a file called `dev-server.log` turning
 * up in the Changes tab would be indistinguishable from something the agent
 * wrote. Truncated on every launch, so it holds one run and cannot grow across
 * a long session.
 */
function getDevServerLogFilePath(packageDirAbs: string, port: number): string {
  return path.posix.join(
    devServerRuntimeDir(packageDirAbs),
    `${DEV_SERVER_PIDFILE_PREFIX}-${port}.log`,
  );
}

function buildLaunchCommand(params: {
  packageManager: PackageManager;
  framework: DevFramework;
  port: number;
  installRootAbs: string;
  packageDirAbs: string;
  installDependencies: boolean;
  pidFilePath: string;
  logFilePath: string;
}): string {
  const runCommand = buildRunCommand(
    params.packageManager,
    params.framework,
    params.port,
  );
  const quotedLogFile = shellQuote(params.logFilePath);
  const commandSteps = [
    `mkdir -p ${shellQuote(path.posix.dirname(params.pidFilePath))}`,
    `printf '%s' "$$" > ${shellQuote(params.pidFilePath)}`,
    // Start each run with an empty log, so what the user is shown after a crash
    // is this run's output and not the tail of the one before it.
    `: > ${quotedLogFile}`,
  ];

  if (params.installDependencies) {
    const installCommand = INSTALL_COMMANDS[params.packageManager];
    commandSteps.push(
      params.installRootAbs === params.packageDirAbs
        ? `${installCommand} >> ${quotedLogFile} 2>&1`
        : `(cd ${shellQuote(params.installRootAbs)} && ${installCommand}) >> ${quotedLogFile} 2>&1`,
    );
  }

  /*
   * `exec`, still, with the redirection applied to what replaces the shell.
   *
   * The pid recorded above has to *be* the dev server for the process-group
   * kill to work, so nothing may be left wrapping it. That is also why there is
   * no exit code here: there is no parent left to collect one. What the app
   * printed on its way out is the next best thing, and it goes here.
   */
  commandSteps.push(`exec ${runCommand} >> ${quotedLogFile} 2>&1`);

  return commandSteps.join(" && ");
}

/**
 * The tail of what this dev server printed, if anything was captured.
 *
 * Only worth asking for when the port is silent — a healthy poll must not pay
 * for a file read every few seconds — so the GET handler gates this behind an
 * explicit request from the client.
 */
async function readDevServerLogTail(
  sandbox: ConnectedSandbox,
  target: Pick<ResolvedDevServerTarget, "packageDirAbs" | "port">,
): Promise<string | null> {
  try {
    const logFilePath = getDevServerLogFilePath(
      target.packageDirAbs,
      target.port,
    );
    const result = await sandbox.exec(
      `tail -n ${DEV_SERVER_LOG_TAIL_LINES} ${shellQuote(logFilePath)} 2>/dev/null`,
      target.packageDirAbs,
      10_000,
    );

    return result.success ? summarizeDevServerLog(result.stdout) : null;
  } catch {
    // Losing the explanation is a worse answer, not a failed request.
    return null;
  }
}

function getDevServerStateFilePath(workingDirectory: string): string {
  return path.posix.join(
    devServerRuntimeDir(workingDirectory),
    DEV_SERVER_STATE_FILENAME,
  );
}

function buildDevServerResponse(
  sandbox: ConnectedSandbox,
  target: Pick<ResolvedDevServerTarget, "packagePath" | "port">,
): DevServerLaunchResponse {
  if (!sandbox.domain) {
    throw new Error(
      "This workspace can't show a live preview. You can still run the dev server and open it yourself.",
    );
  }

  return {
    packagePath: target.packagePath,
    port: target.port,
    url: sandbox.domain(target.port),
  };
}

async function clearPersistedDevServerTarget(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
): Promise<void> {
  await sandbox.exec(
    `rm -f ${shellQuote(getDevServerStateFilePath(workingDirectory))}`,
    workingDirectory,
    5_000,
  );
}

async function readPersistedDevServerTarget(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
): Promise<ResolvedDevServerTarget | null> {
  try {
    const raw = await readRuntimeFile(
      sandbox,
      getDevServerStateFilePath(workingDirectory),
      workingDirectory,
    );
    const persistedTarget = raw ? parsePersistedDevServerTarget(raw) : null;
    if (!persistedTarget) {
      await clearPersistedDevServerTarget(sandbox, workingDirectory);
      return null;
    }

    return buildResolvedDevServerTarget({
      workingDirectory,
      packageDir: persistedTarget.packageDir,
      port: persistedTarget.port,
    });
  } catch {
    return null;
  }
}

async function writePersistedDevServerTarget(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
  target: Pick<ResolvedDevServerTarget, "packageDir" | "port">,
): Promise<void> {
  // Outside the workspace on purpose, so it never shows up as an untracked
  // file in the user's repository — which means the workspace-confined file
  // API rejects it. See lib/sandbox/runtime-files.
  await makeRuntimeDir(
    sandbox,
    devServerRuntimeDir(workingDirectory),
    workingDirectory,
  );
  await writeRuntimeFile(
    sandbox,
    getDevServerStateFilePath(workingDirectory),
    JSON.stringify({
      packageDir: target.packageDir,
      port: target.port,
    }),
    workingDirectory,
  );
}

async function clearDevServerPidFile(
  sandbox: ConnectedSandbox,
  packageDirAbs: string,
  port: number,
): Promise<void> {
  const pidFilePath = getDevServerPidFilePath(packageDirAbs, port);
  await sandbox.exec(`rm -f ${shellQuote(pidFilePath)}`, packageDirAbs, 5_000);
}

async function getRunningDevServerPid(params: {
  sandbox: ConnectedSandbox;
  packageDirAbs: string;
  port: number;
}): Promise<string | null> {
  const { sandbox, packageDirAbs, port } = params;
  const pidFilePath = getDevServerPidFilePath(packageDirAbs, port);

  try {
    const pid = (
      (await readRuntimeFile(sandbox, pidFilePath, packageDirAbs)) ?? ""
    ).trim();
    if (/^[1-9][0-9]*$/.test(pid)) {
      const checkResult = await sandbox.exec(
        `kill -0 ${pid}`,
        packageDirAbs,
        5_000,
      );
      if (checkResult.success) {
        return pid;
      }
    }
    await clearDevServerPidFile(sandbox, packageDirAbs, port);
  } catch {
    // No pid file, which does not mean no server — see below.
  }

  return findDevServerPidByPort(sandbox, packageDirAbs, port);
}

/**
 * Find a dev server nobody told Paco about.
 *
 * The pid file only exists for servers Paco launched. The agent starts one
 * itself all the time — it is the obvious way to check its own work — and that
 * server is invisible to a pid-file-only check, so the panel kept offering
 * "Start dev server" for a port that was already serving, and starting it again
 * would collide.
 *
 * Matching on the listening port rather than the command line keeps this honest
 * about what it can claim: something is serving this port, so the port is in
 * use, whoever started it.
 */
/**
 * Shell that prints the pid listening on a port, via /proc.
 *
 * This used to shell out to `ss`, with `lsof` as a fallback, above a comment
 * claiming `ss` ships in the sandbox image. Neither is installed, so the probe
 * returned nothing every time — which is why adopting an agent-started server
 * never worked and why stopping one found nothing to kill.
 *
 * /proc needs no packages. `/proc/net/tcp` lists listening sockets (state 0A)
 * with their inode; the owning process is whichever one has that socket open.
 */
function findPidOnPortScript(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return [
    `inode=$(awk -v p=":${hex}" '$4=="0A" && $2 ~ p"$" {print $10; exit}' /proc/net/tcp /proc/net/tcp6 2>/dev/null)`,
    '[ -n "$inode" ] || exit 0',
    "for d in /proc/[0-9]*; do",
    // `basename` rather than shell parameter expansion, which a lint rule reads
    // as an un-interpolated template placeholder.
    '  if ls -l "$d/fd" 2>/dev/null | grep -q "socket:\\[$inode\\]"; then basename "$d"; exit 0; fi',
    "done",
  ].join("; ");
}

async function findDevServerPidByPort(
  sandbox: ConnectedSandbox,
  cwd: string,
  port: number,
): Promise<string | null> {
  const probe = await sandbox.exec(findPidOnPortScript(port), cwd, 10_000);
  const pid = probe.stdout.trim();
  return /^[1-9][0-9]*$/.test(pid) ? pid : null;
}

/** Whether anything is listening on a port, regardless of who owns it. */
async function isPortListening(
  sandbox: ConnectedSandbox,
  cwd: string,
  port: number,
): Promise<boolean> {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const result = await sandbox.exec(
    `awk -v p=":${hex}" '$4=="0A" && $2 ~ p"$" {found=1} END {exit !found}' /proc/net/tcp /proc/net/tcp6 2>/dev/null`,
    cwd,
    5_000,
  );
  return result.success;
}

/**
 * The first published port with something listening on it.
 *
 * Only ports Paco publishes are considered — anything else has no host mapping
 * and could not be previewed even if it were serving. The expected port is
 * checked first so an ordinary launch keeps its own port.
 */
async function findListeningPublishedPort(
  sandbox: ConnectedSandbox,
  cwd: string,
  preferredPort: number,
): Promise<number | null> {
  const ports = [
    preferredPort,
    ...DEFAULT_SANDBOX_PORTS.filter((port) => port !== preferredPort),
  ];

  for (const port of ports) {
    const pid = await findDevServerPidByPort(sandbox, cwd, port);
    if (pid) {
      return port;
    }
  }

  return null;
}

async function stopDevServer(params: {
  sandbox: ConnectedSandbox;
  packageDirAbs: string;
  port: number;
}): Promise<boolean> {
  const { sandbox, packageDirAbs, port } = params;
  const pid = await getRunningDevServerPid(params);

  if (!pid) {
    // Nothing to kill. Say so honestly only if the port really is free —
    // otherwise something is serving that we failed to identify, and claiming
    // "stopped" would leave the UI disagreeing with the container.
    await clearDevServerPidFile(sandbox, packageDirAbs, port);
    return !(await isPortListening(sandbox, packageDirAbs, port));
  }

  /*
   * Kill the process group, not the process.
   *
   * The recorded pid is the shell that `exec`s the package manager, and the
   * package manager runs the actual server as a child: `pnpm dev` spawns
   * `vite`, which spawns esbuild. Killing the one pid killed the package
   * manager and left the server holding the port, reparented to init — so
   * "Stop" reported success, the port stayed busy, and a second Start added
   * another orphan on top. Two were running by the time this was found.
   *
   * `docker exec` gives the launched shell its own process group and the
   * children inherit it, so the group is exactly this dev server and nothing
   * else. TERM first, so the server can close its sockets.
   */
  const stopped = await stopProcessGroup({
    sandbox,
    pid,
    cwd: packageDirAbs,
    isStillRunning: () => isPortListening(sandbox, packageDirAbs, port),
  });

  if (stopped) {
    await clearDevServerPidFile(sandbox, packageDirAbs, port);
    return true;
  }

  // Still listening after SIGKILL. Leave the pid file alone so the next call
  // has something to work with, and report the failure rather than a success
  // the user can see is untrue.
  return false;
}

async function findDevServerCandidates(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
): Promise<DevServerCandidate[]> {
  const result = await sandbox.exec(
    PACKAGE_JSON_FIND_COMMAND,
    workingDirectory,
    30_000,
  );

  if (!result.success) {
    console.error("[dev-server] package.json search failed:", result.stderr);
    throw new Error("We couldn't look through this project's files.");
  }

  const packageJsonPaths = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizePackageJsonPath(entry))
    .slice(0, 100);

  const candidates = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath) => {
      try {
        const absolutePath = path.posix.join(workingDirectory, packageJsonPath);
        const manifest = parseManifest(
          await sandbox.readFile(absolutePath, "utf-8"),
        );
        if (!manifest) {
          return null;
        }

        return buildCandidate(manifest, packageJsonPath);
      } catch {
        return null;
      }
    }),
  );

  return candidates.filter(
    (candidate): candidate is DevServerCandidate => candidate !== null,
  );
}

async function resolveDevServerTarget(
  sandbox: ConnectedSandbox,
  workingDirectory: string,
): Promise<LaunchableDevServerTarget | null> {
  const candidate = pickBestCandidate(
    await findDevServerCandidates(sandbox, workingDirectory),
  );
  if (!candidate) {
    return null;
  }

  return toLaunchableDevServerTarget(sandbox, workingDirectory, candidate);
}

async function connectDevServerSandboxForSession(
  sessionId: string,
  userId: string,
  chatId: string | null,
) {
  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    userId,
    sessionId,
    sandboxGuard: isSandboxActive,
    sandboxErrorMessage: WORKSPACE_ASLEEP_DEV_SERVER,
    sandboxErrorStatus: 409,
  });
  if (!sessionContext.ok) {
    return sessionContext;
  }

  const sandboxState = sessionContext.sessionRecord.sandboxState;
  if (!sandboxState) {
    return {
      ok: false as const,
      response: Response.json(
        { error: WORKSPACE_ASLEEP_DEV_SERVER },
        { status: 409 },
      ),
    };
  }

  const sandbox = await connectSandbox(sandboxState, {
    ports: DEFAULT_SANDBOX_PORTS,
  });

  return {
    ok: true as const,
    sandbox,
    // The chat's worktree, not the session repository: the app the user wants
    // to run is the one this chat built, and it only exists on this branch.
    workingDirectory: resolveWorkCwd(sandboxState, chatId),
  };
}

/**
 * Whether a dev server is already running for this chat, and where.
 *
 * Without this the panel could only know about a server it had started itself
 * in the current page: a reload, or a server the agent started, left the
 * Preview tab saying "No dev server running" while the app was serving. The
 * check is the port, not a pid file, so a server nobody told Paco about counts.
 */
export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await context.params;
  const searchParams = new URL(request.url).searchParams;

  try {
    const sandboxResult = await connectDevServerSandboxForSession(
      sessionId,
      authResult.userId,
      searchParams.get("chatId"),
    );
    if (!sandboxResult.ok) {
      return sandboxResult.response;
    }

    const { sandbox, workingDirectory } = sandboxResult;
    const target =
      (await readPersistedDevServerTarget(sandbox, workingDirectory)) ??
      (await resolveDevServerTarget(sandbox, workingDirectory));

    if (
      !target ||
      !(await isPortListening(sandbox, target.packageDirAbs, target.port))
    ) {
      /*
       * `?logs=1` is how the liveness poll asks "and what did it say?".
       *
       * Opt-in because reading the log costs an extra exec, and the readiness
       * poll that runs during a four-minute install hits this same branch every
       * second and a half without ever needing the answer.
       */
      const lastOutput =
        target && searchParams.get("logs") === "1"
          ? await readDevServerLogTail(sandbox, target)
          : null;

      return Response.json({
        running: false,
        ...(lastOutput === null ? {} : { lastOutput }),
      });
    }

    return Response.json({
      running: true,
      ...buildDevServerResponse(sandbox, target),
    });
  } catch (error) {
    console.error("Failed to read dev server status:", error);
    return Response.json(
      {
        error:
          "We couldn't tell whether the dev server is running. Reload the page.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await context.params;

  try {
    const sandboxResult = await connectDevServerSandboxForSession(
      sessionId,
      authResult.userId,
      new URL(request.url).searchParams.get("chatId"),
    );
    if (!sandboxResult.ok) {
      return sandboxResult.response;
    }

    const { sandbox, workingDirectory } = sandboxResult;
    if (!sandbox.execDetached) {
      return Response.json(
        { error: "This workspace can't run a dev server." },
        { status: 500 },
      );
    }

    const persistedTarget = await readPersistedDevServerTarget(
      sandbox,
      workingDirectory,
    );
    if (persistedTarget) {
      const existingPersistedPid = await getRunningDevServerPid({
        sandbox,
        packageDirAbs: persistedTarget.packageDirAbs,
        port: persistedTarget.port,
      });
      if (existingPersistedPid) {
        return Response.json(buildDevServerResponse(sandbox, persistedTarget));
      }

      await clearPersistedDevServerTarget(sandbox, workingDirectory);
    }

    const target = await resolveDevServerTarget(sandbox, workingDirectory);
    if (!target) {
      return Response.json(
        { error: "We couldn't find a dev server to start in this project." },
        { status: 404 },
      );
    }

    const { candidate, packageDirAbs, port } = target;
    const existingPid = await getRunningDevServerPid({
      sandbox,
      packageDirAbs,
      port,
    });
    if (existingPid) {
      await writePersistedDevServerTarget(sandbox, workingDirectory, target);
      return Response.json(buildDevServerResponse(sandbox, target));
    }

    /*
     * Adopt a server the agent started on a different published port.
     *
     * The agent starts dev servers itself, and picks its own port — it might
     * run Vite on 3000 while this code expects 5173. Paco then built a preview
     * URL from the host mapping of the port it *expected*, which forwards to
     * nothing: the user clicked through to "This site can't be reached" while
     * the app was serving fine one port over.
     *
     * Checking every published port means the URL names whichever one is
     * actually listening.
     */
    const adoptedPort = await findListeningPublishedPort(
      sandbox,
      packageDirAbs,
      port,
    );
    if (adoptedPort !== null) {
      const adopted = { ...target, port: adoptedPort };
      await writePersistedDevServerTarget(sandbox, workingDirectory, adopted);
      return Response.json(buildDevServerResponse(sandbox, adopted));
    }

    const { packageManager: preferredManager, installRootAbs } =
      await detectPackageManager(
        sandbox,
        workingDirectory,
        packageDirAbs,
        candidate.packageManagerField,
      );

    // The lockfile names the manager the project wants; the container decides
    // which of those exist. Skipping this check is what made a bun project
    // report "running" over a port nothing was listening on — see
    // _lib/package-manager-fallback.ts.
    const packageManager = await resolveUsablePackageManager(
      sandbox,
      packageDirAbs,
      preferredManager,
    );
    if (!packageManager) {
      return Response.json(
        { error: NO_PACKAGE_MANAGER_MESSAGE },
        { status: 500 },
      );
    }
    const installDependencies = await shouldInstallDependencies({
      sandbox,
      installRootAbs,
      packageDirAbs,
      packageManager,
    });
    const launchCommand = buildLaunchCommand({
      packageManager,
      framework: candidate.framework,
      port,
      installRootAbs,
      packageDirAbs,
      installDependencies,
      pidFilePath: getDevServerPidFilePath(packageDirAbs, port),
      logFilePath: getDevServerLogFilePath(packageDirAbs, port),
    });

    try {
      await sandbox.execDetached(launchCommand, packageDirAbs);
    } catch (error) {
      await clearDevServerPidFile(sandbox, packageDirAbs, port).catch(
        () => undefined,
      );
      throw error;
    }

    await writePersistedDevServerTarget(sandbox, workingDirectory, target);
    return Response.json(buildDevServerResponse(sandbox, target));
  } catch (error) {
    console.error("Failed to launch dev server:", error);
    return Response.json(
      { error: "We couldn't start the dev server. Try again." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await context.params;

  try {
    const sandboxResult = await connectDevServerSandboxForSession(
      sessionId,
      authResult.userId,
      new URL(request.url).searchParams.get("chatId"),
    );
    if (!sandboxResult.ok) {
      return sandboxResult.response;
    }

    const { sandbox, workingDirectory } = sandboxResult;
    const persistedTarget = await readPersistedDevServerTarget(
      sandbox,
      workingDirectory,
    );
    if (persistedTarget) {
      const stopped = await stopDevServer({
        sandbox,
        packageDirAbs: persistedTarget.packageDirAbs,
        port: persistedTarget.port,
      });
      // Only forget the target once it is actually gone. `stopDevServer`
      // deliberately leaves the pid file alone when the process survives, so
      // that the next call has something to work with — clearing the target
      // regardless threw away the other half of that record and left the
      // surviving server unaddressable.
      if (stopped) {
        await clearPersistedDevServerTarget(sandbox, workingDirectory);
      }

      // Answered from the target that was actually launched, whether or not it
      // died. Falling through to package discovery could stop some *other*
      // package's server and report that success while this one kept serving.
      return Response.json({
        stopped,
        packagePath: persistedTarget.packagePath,
        port: persistedTarget.port,
      } satisfies DevServerStopResponse);
    }

    const target = await resolveDevServerTarget(sandbox, workingDirectory);
    if (!target) {
      return Response.json(
        { error: "We couldn't find a dev server to start in this project." },
        { status: 404 },
      );
    }

    const stopped = await stopDevServer({
      sandbox,
      packageDirAbs: target.packageDirAbs,
      port: target.port,
    });
    if (stopped) {
      await clearPersistedDevServerTarget(sandbox, workingDirectory);
    }

    return Response.json({
      stopped,
      packagePath: target.packagePath,
      port: target.port,
    } satisfies DevServerStopResponse);
  } catch (error) {
    console.error("Failed to stop dev server:", error);
    return Response.json(
      { error: "We couldn't stop the dev server. Try again." },
      { status: 500 },
    );
  }
}
