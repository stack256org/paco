import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { listSandboxPreviewPorts, toContainerName } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { appUrl } from "@/lib/app-url";
import {
  getChatsBySessionId,
  getSessionsWithActiveSandbox,
} from "@/lib/db/sessions";
import {
  candidatePreviewHostname,
  previewHostname,
} from "@/lib/preview/hostname";
import {
  candidateContainerPort,
  previewCertDir,
  previewServerBlock,
} from "@/lib/preview/nginx-config";
import { runHostCommand } from "@/lib/reaping/run-host-command";
import { PACO_APP_PORT, PREVIEW_PORT } from "@/lib/sandbox/config";
import {
  getResumableSandboxName,
  getSessionSandboxName,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * Every design-candidate index, in the order candidates are created.
 * `DesignCandidate.index` (`lib/design/candidates.ts`) is the same `1 | 2 |
 * 3` literal union.
 */
const CANDIDATE_INDEXES = [1, 2, 3] as const;

/**
 * Directory holding design-candidate worktrees, relative to the session
 * workspace root — `designs/<chatId>/<n>/`, mirroring
 * `lib/design/candidates.ts`'s own (private) `designWorktreeDir`. Kept as a
 * second, independent literal here rather than importing that helper: it is
 * not exported, and duplicating one path-join convention is cheaper than
 * widening that module's public surface for a single directory name that
 * the plan's Global Constraints already fix (`designs/<chatId>/<n>/`, a
 * sibling of `chats/<chatId>/`).
 */
const DESIGNS_DIRNAME = "designs";

function candidateWorktreeDir(
  workspaceRoot: string,
  chatId: string,
  index: 1 | 2 | 3,
): string {
  return path.join(workspaceRoot, DESIGNS_DIRNAME, chatId, String(index));
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of a chat's design candidates (1..3) currently have a live
 * worktree directory on disk.
 *
 * Directory presence, not `git worktree list`, is the detection signal —
 * cheap, and exactly what `createCandidates`/`removeCandidates`
 * (`lib/design/candidates.ts`) create and delete, which is why those two
 * functions are also what re-runs this whole derivation.
 *
 * A worktree existing here says nothing about whether its dev server has
 * actually started: Docker publishes every port in `DEFAULT_SANDBOX_PORTS`
 * when the container is created, so the port lookup below cannot tell the
 * difference either. A route is therefore written as soon as the worktree
 * exists, and answers 502 until something binds the port behind it. That is
 * deliberate — the alternative is no route at all for the whole window
 * between the worktree appearing and the candidate's agent turn getting
 * round to starting a server, which is most of a design turn.
 */
async function listLiveCandidateIndexes(
  workspaceRoot: string,
  chatId: string,
): Promise<Array<1 | 2 | 3>> {
  const checks = await Promise.all(
    CANDIDATE_INDEXES.map((index) =>
      pathExists(candidateWorktreeDir(workspaceRoot, chatId, index)),
    ),
  );
  return CANDIDATE_INDEXES.filter((_, i) => checks[i]);
}

/**
 * Reconcile nginx's preview routing against every session with a live
 * sandbox — the replacement for Traefik's Docker-label auto-discovery.
 *
 * Traefik watched the Docker socket directly, so a container's labels were
 * the whole routing table and nothing in Paco itself had to enumerate
 * active previews. nginx has no such provider: this is what walks every
 * non-archived session with sandbox state
 * (`getSessionsWithActiveSandbox`), asks Docker in one bulk call which of
 * their containers are actually running and on what host port
 * (`listSandboxPreviewPorts`), and turns the ones with a resolvable preview
 * hostname into one nginx server block each (`previewServerBlock`).
 *
 * Writes one file per active preview under `/etc/paco/nginx/`, removes
 * every stale `paco-preview-*.conf` this run did not regenerate, and
 * reloads nginx — but only after `nginx -t` passes. On any failure from
 * that point on, the previous contents of every file this run touched are
 * restored before this function throws, so a bad sync can leave nginx
 * running the config it had before, never one it cannot start.
 *
 * `/etc/paco/nginx/` — not `/etc/nginx/conf.d/` — because this process runs
 * as the unprivileged `paco` user (see `paco.service`'s `User=`) and
 * `/etc/nginx/conf.d` stays `root:root` on a stock install. `postinst`
 * creates `/etc/paco/nginx/` owned by `paco` and pulls it into nginx's
 * config with a small, static, root-owned
 * `/etc/nginx/conf.d/paco-previews.conf` (`include
 * /etc/paco/nginx/*.conf;`) — a dedicated directory Paco owns outright,
 * rather than loosening permissions on nginx's own conf.d. `nginx -t` and
 * `systemctl reload nginx` below still need root, via the narrow sudoers
 * rule `postinst` installs for exactly those two commands.
 */

const NGINX_CONF_DIR = "/etc/paco/nginx";
const FILE_PREFIX = "paco-preview-";

/**
 * nginx's own binary, and the exact path the sudoers rule `postinst` installs
 * authorises. Named once so the probe below and the `nginx -t` call at the
 * bottom of this file cannot drift apart: when the probe says "there is an
 * nginx on this host", it means the very binary `syncPreviewRoutes` is
 * permitted to test and reload, not some other nginx on `PATH`.
 */
const NGINX_BINARY = "/usr/sbin/nginx";

/**
 * Whether this host has the nginx preview stack `syncPreviewRoutes` needs.
 *
 * - `ready` — reconcile normally. Everything that fails from here on is a
 *   genuine fault and must be reported every time it happens.
 * - `not-installed` — there is no nginx here at all: a development checkout,
 *   or macOS. Nothing to reconcile, ever, in this process.
 * - `incomplete` — nginx is here but Paco's own config directory is not. That
 *   is a broken packaged install, not an environment without previews.
 */
export type PreviewStackStatus =
  | { kind: "ready" }
  | { kind: "not-installed"; reason: string }
  | { kind: "incomplete"; reason: string };

/**
 * The decision, separated from the two `fs.access` calls that feed it.
 *
 * Two signals, because one cannot tell the two failure modes apart:
 *
 * - **The nginx binary.** The package depends on nginx and the sudoers rule
 *   names `/usr/sbin/nginx` by absolute path, so no packaged install can
 *   exist without it. Its absence is positive proof this is not a machine
 *   that serves previews — the dev-checkout and macOS case.
 * - **`/etc/paco/nginx`.** `postinst` creates it (see this file's header for
 *   why previews live there rather than in `/etc/nginx/conf.d`). nginx being
 *   installed while it is missing means the package is half-installed.
 *
 * Note what is deliberately *not* consulted: whether the directory is
 * writable. A `/etc/paco/nginx` that exists but is root-owned is exactly the
 * broken packaged install an operator must hear about, so it classifies as
 * `ready` and lets the write fail loudly on every sweep. Folding "cannot
 * write there" into "this environment has no previews" is the bug this whole
 * probe exists to avoid.
 */
export function classifyPreviewStack(probe: {
  nginxBinary: boolean;
  confDir: boolean;
}): PreviewStackStatus {
  if (!probe.nginxBinary) {
    return {
      kind: "not-installed",
      reason: `no nginx on this host (${NGINX_BINARY} does not exist), so there are no preview routes to reconcile — expected on a development checkout or on macOS, where previews are not served at all`,
    };
  }

  if (!probe.confDir) {
    return {
      kind: "incomplete",
      reason: `nginx is installed but ${NGINX_CONF_DIR} does not exist — the package's postinst creates it, so previews cannot be routed until it is restored (\`sudo apt install --reinstall paco\`)`,
    };
  }

  return { kind: "ready" };
}

/** `classifyPreviewStack` against this host's filesystem. */
export async function previewStackStatus(): Promise<PreviewStackStatus> {
  const [nginxBinary, confDir] = await Promise.all([
    pathExists(NGINX_BINARY),
    pathExists(NGINX_CONF_DIR),
  ]);
  return classifyPreviewStack({ nginxBinary, confDir });
}

interface ActivePreviewRoute {
  hostname: string;
  upstreamPort: number;
  /** Set only for a design-candidate's own route — see `previewServerBlock`'s
   * `isDesignCandidate`. Omitted (not `false`) for an ordinary chat route. */
  isDesignCandidate?: true;
}

/**
 * Reconcile one chat's live design candidates into extra preview routes,
 * alongside its own.
 *
 * `listSandboxPreviewPorts` is called at most once per distinct candidate
 * container port across the *entire* sync (`portsForContainerPort` below
 * memoizes it) — not once per chat — since it is already a bulk call across
 * every running container, exactly like the chat-route lookup above it
 * reuses `portsByContainer` for the same reason.
 */
async function collectCandidateRoutes(params: {
  chatId: string;
  containerName: string;
  workspaceRoot: string;
  previewBaseDomain: string | null;
  portsForContainerPort: (
    containerPort: number,
  ) => Promise<Map<string, number>>;
}): Promise<ActivePreviewRoute[]> {
  const {
    chatId,
    containerName,
    workspaceRoot,
    previewBaseDomain,
    portsForContainerPort,
  } = params;

  const liveIndexes = await listLiveCandidateIndexes(workspaceRoot, chatId);
  if (liveIndexes.length === 0) {
    return [];
  }

  const routes: ActivePreviewRoute[] = [];
  for (const index of liveIndexes) {
    const hostname = candidatePreviewHostname(chatId, index, previewBaseDomain);
    if (!hostname) {
      continue;
    }

    const ports = await portsForContainerPort(candidateContainerPort(index));
    const upstreamPort = ports.get(containerName);
    if (!upstreamPort) {
      // The container is not publishing this port at all — it is not
      // running, or it was created before `DEFAULT_SANDBOX_PORTS` included
      // it. There is no host port to route to, which is a different thing
      // from "the dev server has not started yet": that case still gets a
      // route, and answers 502 until it has.
      continue;
    }

    routes.push({ hostname, upstreamPort, isDesignCandidate: true });
  }

  return routes;
}

export async function collectActivePreviewRoutes(
  previewBaseDomain: string | null,
): Promise<ActivePreviewRoute[]> {
  const sessions = (await getSessionsWithActiveSandbox()).filter((session) =>
    isSandboxActive(session.sandboxState),
  );

  if (sessions.length === 0) {
    return [];
  }

  const portsByContainer = await listSandboxPreviewPorts(PREVIEW_PORT);

  // Memoized per distinct candidate container port, and only ever fetched
  // when some chat actually has a live candidate worktree — most syncs, on
  // an instance with no design turn in flight, never call this at all.
  const candidatePortMaps = new Map<number, Promise<Map<string, number>>>();
  function portsForContainerPort(
    containerPort: number,
  ): Promise<Map<string, number>> {
    let promise = candidatePortMaps.get(containerPort);
    if (!promise) {
      promise = listSandboxPreviewPorts(containerPort);
      candidatePortMaps.set(containerPort, promise);
    }
    return promise;
  }

  const routes: ActivePreviewRoute[] = [];

  for (const session of sessions) {
    const sandboxName =
      getResumableSandboxName(session.sandboxState) ??
      getSessionSandboxName(session.id);
    const containerName = toContainerName(sandboxName);

    const upstreamPort = portsByContainer.get(containerName);
    if (!upstreamPort) {
      // Sandbox state says "active" but nothing is actually running right
      // now (hibernated, still starting) — nothing to route to yet.
      continue;
    }

    // Mirrors buildSessionPreviewWiring's old choice: a sandbox is per
    // session, a preview is per chat, and only one chat's dev server can
    // occupy the container's published port at a time, so the session's
    // most recently active chat is the one whose hostname gets wired up.
    const chats = await getChatsBySessionId(session.id);
    const previewChat = chats[0];
    if (!previewChat) {
      continue;
    }

    const hostname = previewHostname(previewChat.id, previewBaseDomain);
    if (hostname) {
      routes.push({ hostname, upstreamPort });
    }

    // A design candidate is a worktree of THIS chat's own repository, so it
    // runs inside the very same container — its dev server just has to be
    // told to bind `candidateContainerPort(n)` instead of `PREVIEW_PORT`
    // (see that function's doc comment in `nginx-config.ts`).
    if (!isSandboxActive(session.sandboxState)) {
      // Already excluded by the `sessions` filter above — this is here
      // purely so TypeScript narrows `session.sandboxState` to a non-null
      // `SandboxState` before `hostWorkspaceFor` below, which requires one.
      continue;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = hostWorkspaceFor(session.sandboxState);
    } catch {
      // Sandbox state carries neither `hostWorkspace` nor a resolvable
      // name — already unusual enough that the chat's own route above may
      // also be stale, but candidates are pure upside here: skipping them
      // costs nothing beyond not showing candidates for this one session.
      continue;
    }

    const candidateRoutes = await collectCandidateRoutes({
      chatId: previewChat.id,
      containerName,
      workspaceRoot,
      previewBaseDomain,
      portsForContainerPort,
    });
    routes.push(...candidateRoutes);
  }

  return routes;
}

function confPathForHostname(hostname: string): string {
  return path.join(NGINX_CONF_DIR, `${FILE_PREFIX}${hostname}.conf`);
}

async function listExistingPreviewConfPaths(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(NGINX_CONF_DIR);
  } catch {
    // Nothing there yet (fresh install, or the directory does not exist for
    // some other reason) — treated the same as "no stale files," not an
    // error worth stopping a sync over.
    return [];
  }

  return entries
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(".conf"))
    .map((name) => path.join(NGINX_CONF_DIR, name));
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The certificate directory for `hostname` if it holds a usable key pair,
 * otherwise `null` — meaning serve this preview over plain HTTP.
 *
 * Both halves are checked because nginx needs both, and a directory holding
 * only `fullchain.pem` fails `nginx -t` exactly as a missing one does.
 */
async function existingPreviewCertDir(
  hostname: string,
): Promise<string | null> {
  const dir = previewCertDir(hostname);
  try {
    await Promise.all([
      fs.access(`${dir}/fullchain.pem`),
      fs.access(`${dir}/privkey.pem`),
    ]);
    return dir;
  } catch {
    return null;
  }
}

/** Undo a partially-applied sync: restore every touched path's prior content, or remove it if it did not exist before. */
async function restore(backup: Map<string, string | null>): Promise<void> {
  await Promise.all(
    Array.from(backup.entries()).map(async ([filePath, previousContent]) => {
      if (previousContent === null) {
        await fs.rm(filePath, { force: true });
      } else {
        await fs.writeFile(filePath, previousContent, { mode: 0o644 });
      }
    }),
  );
}

export async function syncPreviewRoutes(): Promise<void> {
  const settings = await readInstanceSettings();
  const routes = await collectActivePreviewRoutes(settings.previewBaseDomain);

  const desiredFiles = new Map<string, string>();
  for (const route of routes) {
    desiredFiles.set(
      confPathForHostname(route.hostname),
      previewServerBlock({
        hostname: route.hostname,
        upstreamPort: route.upstreamPort,
        appPort: PACO_APP_PORT,
        // Only ever names a certificate that is actually on disk. See the
        // `certDir` doc comment in nginx-config.ts: nginx validates
        // `ssl_certificate` paths at config-test time, so naming a missing
        // file fails `nginx -t` and takes down *every* preview route on the
        // instance, not just this one.
        certDir: settings.tlsEnabled
          ? await existingPreviewCertDir(route.hostname)
          : null,
        isDesignCandidate: route.isDesignCandidate ?? false,
        // Only a candidate block actually uses this (see its doc comment
        // in nginx-config.ts) — computed unconditionally anyway since
        // `appUrl()` is a cheap, synchronous read of `APP_URL`.
        appOrigin: route.isDesignCandidate ? appUrl().origin : undefined,
      }),
    );
  }

  const existingPaths = await listExistingPreviewConfPaths();
  const staleExistingPaths = existingPaths.filter(
    (filePath) => !desiredFiles.has(filePath),
  );

  // Snapshot every path this run will touch — written or removed — before
  // touching any of them, so a failure partway through has something
  // complete to restore.
  const touchedPaths = new Set<string>([
    ...desiredFiles.keys(),
    ...staleExistingPaths,
  ]);
  const backup = new Map<string, string | null>();
  await Promise.all(
    Array.from(touchedPaths).map(async (filePath) => {
      backup.set(filePath, await readIfExists(filePath));
    }),
  );

  await fs.mkdir(NGINX_CONF_DIR, { recursive: true });
  await Promise.all(
    Array.from(desiredFiles.entries()).map(([filePath, content]) =>
      fs.writeFile(filePath, content, { mode: 0o644 }),
    ),
  );
  await Promise.all(
    staleExistingPaths.map((filePath) => fs.rm(filePath, { force: true })),
  );

  // Gated: nginx is never reloaded with a config that fails its own test,
  // and never left holding one either — a failure here restores exactly
  // what was in place before this function ran.
  const test = await runHostCommand("sudo", ["-n", NGINX_BINARY, "-t"]);
  if (!test.ok) {
    await restore(backup);
    throw new Error(
      `syncPreviewRoutes: \`nginx -t\` failed after writing preview routes; restored the previous config.\n${test.stderr || test.stdout}`,
    );
  }

  const reload = await runHostCommand("sudo", [
    "-n",
    "/usr/bin/systemctl",
    "reload",
    "nginx",
  ]);
  if (!reload.ok) {
    await restore(backup);
    throw new Error(
      `syncPreviewRoutes: \`systemctl reload nginx\` failed after writing preview routes; restored the previous config.\n${reload.stderr || reload.stdout}`,
    );
  }
}
