import "server-only";

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type Capability,
  discoverPlugin,
  type PluginManifest,
} from "@paco/plugin-kit";
import { upsertPlugin } from "@/lib/db/plugins";
import { dataDir } from "@/lib/memory/paths";
import { findSymlink, hashDirectory } from "@/lib/plugins/content-hash";

const execFileAsync = promisify(execFile);

export type InstallSource =
  | { kind: "github"; repo: string; ref?: string }
  | { kind: "local"; path: string };

export type InstallResult =
  | { ok: true; pluginId: string; requested: Capability[] }
  | { ok: false; error: string };

/**
 * Every id/ref that ends up in a `git clone` argv, validated before it gets
 * anywhere near `execFile`.
 *
 * `execFile` never touches a shell, so these can't be used to inject a
 * second command — but an unvalidated `ref` could still smuggle in an
 * arbitrary `git` flag (say, `--upload-pack=...`) as its own argv element.
 * Restricting both to inert characters closes that off too.
 */
const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_REF_PATTERN = /^[\w./-]+$/;

/**
 * Builds the argv for `git clone` of a GitHub repo, without the destination
 * directory (the caller appends that, since it's only known once a temp
 * directory has been created).
 *
 * Exported so the github install path can be unit-tested by asserting on
 * this argv directly — no network access, and no need to mock `execFile`
 * just to exercise the validation and flag-building logic.
 */
export function buildCloneArgs(repo: string, ref?: string): string[] {
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid GitHub repo "${repo}"`);
  }
  if (ref !== undefined && !GITHUB_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid GitHub ref "${ref}"`);
  }

  const args = ["clone", "--depth", "1"];
  if (ref !== undefined) {
    args.push("--branch", ref);
  }
  args.push(`https://github.com/${repo}`);
  return args;
}

/**
 * Root directory Paco installs plugins under.
 *
 * Reuses `dataDir()` (`apps/web/lib/memory/paths.ts`) — the same
 * `PACO_HOME`-derived data dir memory already uses — rather than a second
 * implementation of the same env-var-with-home-relative-fallback
 * convention, with `PACO_PLUGINS_DIR` as the plugin-specific override the
 * spec calls for. `path.resolve` anchors a relative `PACO_PLUGINS_DIR` to
 * the process's cwd instead of leaving it to whatever relative-path
 * resolution the first fs call happens to do.
 */
function pluginsDir(): string {
  if (process.env.PACO_PLUGINS_DIR) {
    return path.resolve(process.env.PACO_PLUGINS_DIR);
  }
  return path.join(dataDir(), "plugins");
}

/**
 * Plugin ids, per the plan (spec Section 2) and `pluginManifestSchema`'s
 * `name` field (`packages/plugin-kit/manifest.ts`). No `.`, no `/`, no
 * uppercase — which is what makes it safe to join straight onto a
 * filesystem path below: a string matching this can never contain `..` or a
 * path separator, so it can never walk `pluginDir()` outside its root by
 * itself.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Where one installed plugin lives on disk.
 *
 * Exported so callers that scan an installed plugin's own slots (skills,
 * agents) — `pluginSkillContributions`/`pluginAgentContributions` in
 * `contributions.ts` — resolve the same directory `commitInstall` moved the
 * plugin into, without a second copy of the `pluginsDir()` convention.
 *
 * Throws, rather than silently building a path, on two things:
 *
 * - `id` failing `PLUGIN_ID_PATTERN` — this is the id every caller in this
 *   codebase gets from a validated manifest or a plugins-table row, never
 *   from unreviewed user input directly, but a settings action taking a raw
 *   `pluginId` string from the client is exactly the kind of call site a
 *   future change could add without threading a fresh validation call
 *   through it. Rejecting here means that mistake fails loud instead of
 *   quietly building `<pluginsRoot>/../../etc` and handing it to `rm -rf`.
 * - the resolved (symlink-followed) path landing outside the resolved
 *   plugins root — belt-and-braces alongside the id check above: the id
 *   pattern alone already rules out `..` in the requested id, but a
 *   directory entry actually named e.g. `my-plugin` could itself be a
 *   symlink pointing elsewhere (see `SECURITY.md`'s symlink-escape finding
 *   for why "a path under the allowed prefix" and "a path actually inside
 *   it" are not the same claim). A path that doesn't exist yet can't have
 *   escaped through a symlink, so a missing `candidate` (or missing
 *   `pluginsRoot`) skips this check rather than failing it.
 */
export function pluginDir(id: string): string {
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(`Invalid plugin id ${JSON.stringify(id)}`);
  }

  const root = pluginsDir();
  const candidate = path.join(root, id);

  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    resolvedRoot = realpathSync(root);
    resolvedCandidate = realpathSync(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return candidate;
    }
    throw error;
  }

  const isContained =
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep);
  if (!isContained) {
    throw new Error(
      `plugin "${id}" resolves outside the plugins root (${resolvedCandidate} is not under ${resolvedRoot})`,
    );
  }

  return candidate;
}

/** Fetches `source` into `destDir`, which already exists as an empty directory. */
async function fetchInto(
  source: InstallSource,
  destDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (source.kind === "local") {
    try {
      await cp(source.path, destDir, { recursive: true });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to copy local plugin: ${describe(error)}`,
      };
    }
  }

  let args: string[];
  try {
    args = [...buildCloneArgs(source.repo, source.ref), destDir];
  } catch (error) {
    return { ok: false, error: describe(error) };
  }

  try {
    await execFileAsync("git", args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `git clone failed: ${describe(error)}` };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `error.code` of a node `fs` error (e.g. `"ENOENT"`), if it has one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

/** Removes a directory tree, swallowing errors — best-effort cleanup only. */
async function removeQuietly(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {
    // Best-effort: a cleanup failure here must not mask the real result.
  });
}

/**
 * Fetches a plugin (from GitHub or a local path), validates its manifest,
 * and records it — installed disabled, with no granted capabilities.
 * Consent to run, and to grant any capability, happens later in the UI.
 *
 * Always resolves (never throws): every failure path — invalid source,
 * failed clone/copy, invalid manifest, a failed re-install swap, or a
 * failed DB write — returns `{ ok: false, error }` instead. Nothing is
 * left half-installed: the fetch happens in a temp directory first, and a
 * failed re-install restores the previously installed copy rather than
 * deleting it.
 *
 * `installedBy` is REQUIRED, not optional, and it is what gives the
 * installed plugin a security principal at all (`plugins.installedBy`,
 * `lib/db/schema.ts`): capabilities that act inside a session authorize as
 * the administrator who installed the plugin, so a row without one can do
 * nothing. Every call site reaches this behind `requireAdmin`, so an
 * administrator's id is always available; making the parameter mandatory
 * means a future install path cannot quietly create a principal-less row
 * that silently fails closed at runtime — it fails to compile instead.
 */
export async function installPlugin(
  source: InstallSource,
  installedBy: string,
): Promise<InstallResult> {
  const pluginsRoot = pluginsDir();

  try {
    await mkdir(pluginsRoot, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `Failed to prepare plugins directory: ${describe(error)}`,
    };
  }

  // Created inside pluginsRoot (not os.tmpdir()) so the later "move into
  // place" is a same-filesystem `rename` — atomic, not a copy-then-delete
  // that could leave a partial tree on failure.
  let tempDir: string;
  try {
    tempDir = await mkdtemp(path.join(pluginsRoot, ".install-tmp-"));
  } catch (error) {
    return {
      ok: false,
      error: `Failed to create temp directory: ${describe(error)}`,
    };
  }

  try {
    const fetched = await fetchInto(source, tempDir);
    if (!fetched.ok) {
      return fetched;
    }

    // Fail closed on a symlink anywhere in the fetched tree, before it is
    // hashed or moved into place: a symlink can point outside the
    // plugin's own directory, so silently following or copying it would
    // let an installed plugin read (or serve, once running) files it was
    // never granted access to. This check does not depend on manifest
    // validity — a symlink is rejected even if the manifest is otherwise
    // fine.
    const symlinkPath = await findSymlink(tempDir);
    if (symlinkPath) {
      return { ok: false, error: `plugin contains a symlink: ${symlinkPath}` };
    }

    const discovered = await discoverPlugin(tempDir);
    if (!discovered.ok) {
      return { ok: false, error: discovered.error };
    }

    const { manifest } = discovered.plugin;
    const pluginId = manifest.name;
    const finalDir = path.join(pluginsRoot, pluginId);

    return await commitInstall({
      tempDir,
      finalDir,
      pluginId,
      manifest,
      installedBy,
      sourceLabel:
        source.kind === "github"
          ? `github:${source.repo}${source.ref ? `#${source.ref}` : ""}`
          : `local:${source.path}`,
    });
  } finally {
    await removeQuietly(tempDir);
  }
}

/**
 * Moves a validated plugin tree from `tempDir` into `finalDir` and records
 * it in the database.
 *
 * If a plugin is already installed at `finalDir` (a re-install), the old
 * copy is renamed aside first rather than removed outright: if the swap or
 * the DB write then fails, the old copy is renamed back so a failed
 * re-install never destroys a previously working install.
 */
async function commitInstall(params: {
  tempDir: string;
  finalDir: string;
  pluginId: string;
  manifest: PluginManifest;
  installedBy: string;
  sourceLabel: string;
}): Promise<InstallResult> {
  const { tempDir, finalDir, pluginId, manifest, installedBy, sourceLabel } =
    params;
  const backupDir = `${finalDir}.bak-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let hasBackup = false;
  try {
    await rename(finalDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      // finalDir exists but couldn't be renamed aside (permissions, a
      // concurrent process, etc.) — bail out without touching anything.
      // `finalDir` was never renamed, and `tempDir` is still just a temp
      // directory the caller's `finally` will clean up.
      return {
        ok: false,
        error: `Failed to back up the existing plugin before replacing it: ${describe(error)}`,
      };
    }
    // ENOENT: no existing install at finalDir — a fresh install, not a
    // re-install.
  }

  try {
    await rename(tempDir, finalDir);
  } catch (error) {
    if (hasBackup) {
      await rename(backupDir, finalDir).catch(() => {
        // Restoring the backup is best-effort; the original error below is
        // what the caller needs to see either way.
      });
    }
    return {
      ok: false,
      error: `Failed to move plugin into place: ${describe(error)}`,
    };
  }

  try {
    const contentHash = await hashDirectory(finalDir);
    await upsertPlugin({
      id: pluginId,
      source: sourceLabel,
      version: manifest.version,
      contentHash,
      manifest,
      grantedCapabilities: [],
      enabled: false,
      installedBy,
    });
  } catch (error) {
    // Roll back the filesystem swap too: remove the newly-moved tree and
    // restore the previous one, so a DB failure doesn't leave disk and DB
    // disagreeing about which copy is installed.
    await removeQuietly(finalDir);
    if (hasBackup) {
      await rename(backupDir, finalDir).catch(() => {
        // Best-effort restore; the DB error is the one that matters here.
      });
    }
    return { ok: false, error: `Failed to record plugin: ${describe(error)}` };
  }

  if (hasBackup) {
    await removeQuietly(backupDir);
  }

  return { ok: true, pluginId, requested: manifest.capabilities };
}

/**
 * Re-verifies an installed plugin's on-disk content against the hash
 * recorded at install/grant time, before anything starts its host.
 *
 * `contentHash` (`lib/db/schema.ts`) is written once, at install, and
 * otherwise just sits in the row — nothing re-reads it without this
 * function. An operator's consent (`setPluginGrants`) is consent to the
 * code that was reviewed at that moment; a plugin directory that changes on
 * disk afterwards — a manual edit, a compromised host, anything other than
 * a fresh `installPlugin` call recomputing and rewriting the hash — must
 * not run on that stale consent. Shared by every start path (the settings
 * action here, and — once wired — `lib/plugins/registry.ts`'s
 * `ensurePluginsStarted`) so there is exactly one place this check is made,
 * not two that can drift.
 */
export async function recheckPluginIntegrity(
  id: string,
  expectedContentHash: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let actualHash: string;
  try {
    actualHash = await hashDirectory(pluginDir(id));
  } catch (error) {
    return {
      ok: false,
      error: `Could not verify plugin "${id}"'s integrity: ${describe(error)}`,
    };
  }

  if (actualHash !== expectedContentHash) {
    return {
      ok: false,
      error: `Plugin "${id}" has changed on disk since it was installed — its content hash no longer matches what was reviewed and consented to. Reinstall it to review and re-consent to the current code before it can run.`,
    };
  }

  return { ok: true };
}
