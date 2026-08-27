// No "server-only" marker: this is pure text classification with no server
// dependencies, and the workflow tests import it directly.

import {
  isProvisioningFailureReason,
  type ProvisioningFailureReason,
  provisioningFailureReason,
  readMarkedSetupReason,
} from "./provisioning-errors";

/**
 * Turn a failed workspace setup into something a person can act on.
 *
 * Every one of these failures used to reach the user as the same eleven words:
 * "Workspace setup failed. Try again in a moment." Docker not being installed,
 * Docker not being started, the sandbox image never having been built, a
 * private repository the account cannot see, and a full disk were all that one
 * sentence — and "try again in a moment" is wrong for every one of them,
 * because none of them clears itself. The actionable text existed; it went to
 * `console.error` and to a database column no route ever returns.
 *
 * The reason is a value (see `provisioning-errors.ts`); this file is the only
 * place that turns it into words. `gh-failure-copy.ts` does the same job for
 * GitHub, and the two are deliberately shaped alike.
 *
 * Docker is named on purpose in some of these. Paco is self-hosted: whoever
 * reads "Docker isn't running" is the same person who installed it, and hiding
 * the one word that identifies the problem helps nobody.
 */

// A download link is the wrong advice for the machine most likely to be reading
// this. `install.sh` installs `docker.io` from apt, and `postinst` prints
// `apt-get install -y docker.io && dpkg-reconfigure paco` for exactly this
// state — so on a server that is the fix, verbatim, and it does not involve a
// website. The reconfigure is the half that is easy to miss: it is what puts
// the `paco` user back in the `docker` group once Docker exists.
//
// Both installers try to prevent this state, so a server that reaches it is
// already off the happy path; the Mac half is for someone running from a
// checkout. As with the other Docker copy, neither half asserts which machine
// the reader is on.
export const DOCKER_MISSING =
  "Paco runs your app inside Docker, and Docker isn't installed on this computer. On a Linux server, run `sudo apt-get install -y docker.io && sudo dpkg-reconfigure paco` — the same commands Paco's own installer uses, and the reconfigure is what gets Paco back onto the Docker socket afterwards. On a Mac, install Docker from docker.com and start it. Then try again.";

// Deliberately does not guess which machine the reader is on. Paco ships as a
// .deb for Debian/Ubuntu with systemd, and it is also run locally on a Mac
// while developing; naming one and being wrong costs the reader the fix.
export const DOCKER_NOT_RUNNING =
  "Docker is installed but isn't running, so there's nowhere to build your app. On a Linux server, start it with `sudo systemctl start docker`; on a Mac, open the Docker app and wait for it to say it's running. Then try again.";

// The daemon answered — this is not a stopped Docker, and telling the reader to
// start one wastes their afternoon. On the packaged install Paco runs as the
// `paco` system user, and `/var/run/docker.sock` is owned by root:docker.
//
// The restart is load-bearing and the sentence says why: a process's
// supplementary groups are read once, when it starts. `usermod` alone changes
// nothing for the already-running service, so a reader who runs half of this
// fix sees exactly the same failure and concludes it did not work.
export const DOCKER_PERMISSION =
  "Docker is running, but it refused to talk to Paco: the user Paco runs as isn't allowed to use the Docker socket. On the server, run `sudo usermod -aG docker paco && sudo systemctl restart paco`. The restart isn't optional — a process only picks up its group membership when it starts, so until Paco restarts it will keep being refused.";

// Rootless is a reasonable thing for a careful admin to have set up, so this
// says plainly that it cannot work rather than implying they misconfigured it.
// The sandbox bind-mounts the workspace and runs as the host's own uid;
// rootless remaps every id through a user namespace (`/etc/subuid`), so uid 106
// inside the container writes files owned by uid 100106 outside it and Paco
// cannot read back its own workspace.
export const DOCKER_ROOTLESS =
  "This computer runs Docker in rootless mode, which Paco doesn't support. Paco's workspace is a folder shared between the server and the container, so the container has to run as the same user as the server — and rootless Docker remaps every user id, which means files written in the workspace come back owned by a user Paco can't read or write. Install the normal system-wide Docker daemon on this host, the one that runs as root, then try again.";

// Paco downloads this image itself now, so reaching here means the download
// failed rather than that somebody forgot a build step. The old copy told the
// reader to run `docker build ... packages/sandbox/docker`, which is impossible
// on a host installed from the .deb: there is no checkout to build from.
// No literal tag in here any more. The image is pinned to the installed
// version, so a `docker pull …:latest` in this sentence would hand the reader a
// command that fetches the wrong image and leaves them no better off. `paco
// status` prints the version this host actually wants.
export const IMAGE_MISSING =
  "Paco couldn't download the workspace image it runs your app in. Check this computer can reach ghcr.io, then try again. `paco status` on the server prints the version, and `docs/self-hosting.md` has the pull command if you need to fetch it by hand.";

export const REPO_NOT_FOUND =
  "We couldn't find that repository on GitHub. It may have been renamed or deleted, or the connected account may not be able to see it. Check it in Settings, then try again.";

export const REPO_AUTH_FAILED =
  "GitHub wouldn't let Paco read that repository. Reconnect your GitHub account in Settings with one that can open it, then try again.";

export const DISK_FULL =
  "This computer has run out of disk space, so the workspace couldn't be set up. Free some space, then try again — nothing you've already done has been lost.";

// Names CPUs, because that is what the daemon refused over, and says the
// number is Paco's fault rather than the operator's — Paco asked every host
// for four regardless of what it had, so a correctly-built 2-CPU server was
// told to go and check a healthy Docker daemon. The request is clamped now, so
// this should only be reachable by a host that stored the failure before
// upgrading.
export const INSUFFICIENT_CPU =
  "This computer has fewer CPUs than Paco tried to give the workspace, so Docker refused to create it. Paco now matches the request to the machine, so upgrading to the latest version fixes this without changing anything on the server: run `sudo paco upgrade` and try again. Nothing about the Docker installation is wrong.";

export const NETWORK =
  "We couldn't reach GitHub to download your project. Check this computer's internet connection, then try again.";

export const TIMED_OUT =
  "Setting up this workspace took longer than we waited for. A large project can take a few minutes the first time — try again, and it should pick up where it left off.";

export const GITHUB_NOT_CONNECTED =
  "This project lives on GitHub, and no GitHub account is connected yet. Connect one in Settings, then try again.";

export const ARCHIVED =
  "This session is archived, so its workspace has been put away. Unarchive it to pick up where you left off.";

export const GENERIC =
  "We couldn't set up a workspace for this project. Try again in a moment — if it keeps happening, check that Docker is running.";

const REASON_COPY: Record<ProvisioningFailureReason, string> = {
  archived: ARCHIVED,
  "github-not-connected": GITHUB_NOT_CONNECTED,
  "docker-missing": DOCKER_MISSING,
  "docker-not-running": DOCKER_NOT_RUNNING,
  "docker-permission": DOCKER_PERMISSION,
  "docker-rootless": DOCKER_ROOTLESS,
  "image-missing": IMAGE_MISSING,
  "repo-not-found": REPO_NOT_FOUND,
  "repo-auth-failed": REPO_AUTH_FAILED,
  "disk-full": DISK_FULL,
  "insufficient-cpu": INSUFFICIENT_CPU,
  network: NETWORK,
  "timed-out": TIMED_OUT,
  unknown: GENERIC,
};

/** What the user reads. Never contains raw output, a path, or an exit code. */
export function setupFailureMessage(reason: ProvisioningFailureReason): string {
  return REASON_COPY[reason];
}

/**
 * Whether pressing the same button again could plausibly work.
 *
 * Drives whether the UI offers a retry at all. Offering "Try again" for a
 * missing Docker installation trains people to press it forever.
 */
export function isSetupFailureRetryable(
  reason: ProvisioningFailureReason,
): boolean {
  // `insufficient-cpu` is deliberately absent: nothing about pressing the
  // button again adds a CPU, and the fix is an upgrade, not a retry.
  return (
    reason === "network" ||
    reason === "timed-out" ||
    reason === "disk-full" ||
    reason === "unknown"
  );
}

/**
 * Ordered, and the order is load-bearing: the text being matched is whatever
 * Docker and git wrote, and they cheerfully report several things at once.
 *
 * These patterns are checked against **third-party output**, never against
 * Paco's own copy. That distinction is the whole reason this is allowed to be
 * string matching at all — `provisioning-errors.ts` documents the outage caused
 * by keying on our own sentences, which any plain-language pass would rewrite.
 * Docker's and git's wording is an interface we do not control and cannot
 * rewrite, so matching it is the only option; the result is immediately
 * converted to a reason, and nothing downstream ever looks at the text again.
 *
 * Verified against Docker 29.6 and git 2.39 on macOS, not guessed:
 *
 *   spawn docker ENOENT
 *   Cannot connect to the Docker daemon at tcp://…. Is the docker daemon running?
 *   failed to connect to the docker API at unix:///…: dial unix …: connect: no such file or directory
 *   remote: Repository not found. / fatal: repository '…' not found
 *   remote: Invalid username or token. Password authentication is not supported…
 *   fatal: Authentication failed for '…'
 *
 * The disk-full matcher runs first because a full disk makes everything else
 * fail with its own wording on top, and "free some space" is the only advice
 * that helps in that state.
 */
const MATCHERS: ReadonlyArray<{
  test: RegExp;
  reason: ProvisioningFailureReason;
}> = [
  {
    test: /no space left on device|enospc|disk quota exceeded|write error: no space/,
    reason: "disk-full",
  },
  {
    // Docker's own words when `NanoCpus` exceeds the host's CPU count. Ahead of
    // every Docker matcher below because those key on the daemon and the
    // socket, and this failure is neither: the daemon answered, and answered
    // correctly. Verified against Docker 29.1.3 on a 2-CPU Ubuntu server:
    //
    //   (HTTP code 400) bad parameter - range of CPUs is from 0.01 to 2.00,
    //   as there are only 2 CPUs available
    //
    // Anchored on `range of cpus`, not on `cpus`: git and Docker both mention
    // CPUs in unrelated output, and a looser pattern would start swallowing
    // failures that have nothing to do with sizing.
    test: /range of cpus is from|only \d+(\.\d+)? cpus? available/,
    reason: "insufficient-cpu",
  },
  {
    // Node's spawn error for a binary that is not on PATH. Matched before the
    // daemon patterns: with no `docker` at all there is no daemon to talk to,
    // and "start Docker Desktop" is useless advice when it is not installed.
    test: /spawn docker enoent|docker: (command )?not found|enoent.*\bdocker\b/,
    reason: "docker-missing",
  },
  {
    // Rootless MUST stay ahead of the permission matcher below, and the reason
    // is not stylistic: a rootless daemon refuses another user's connection in
    // the *same* words as the group problem, so whichever matcher runs first
    // wins the string outright. The two fixes are opposite — the group advice
    // would send a rootless admin to `usermod`, which cannot work, when the
    // honest answer is that Paco cannot use their daemon at all. Do not
    // reorder these two; the guard test is the only other thing that would
    // notice. Measured on Ubuntu 24.04 — the socket lives under
    // `/run/user/<uid>/`, the shim is `rootlesskit`, the unit is
    // `dockerd-rootless.sh`.
    test: /rootlesskit|dockerd-rootless|\/run\/user\/\d+\/[\w.-]*docker[\w.-]*\.sock/,
    reason: "docker-rootless",
  },
  {
    // MUST stay ahead of the daemon matcher below. Docker names the socket in
    // its permission error, the daemon matcher matches any mention of
    // `docker.sock`, and the result was that the single most common
    // self-hosting failure — a user who is not in the `docker` group — told
    // people to start a daemon that was already running.
    //
    // Verified on Docker 29.6 / Ubuntu 24.04:
    //
    //   permission denied while trying to connect to the Docker daemon socket
    //     at unix:///var/run/docker.sock
    //   Got permission denied while trying to connect to the Docker daemon socket
    //   error during connect: dial unix /var/run/docker.sock: connect: permission denied
    //
    // Not a bare `permission denied`: that also arrives from git as
    // `Permission denied (publickey)`, which is a `repo-auth-failed`.
    test: /permission denied while trying to connect|dial unix [^\s]*docker\.sock: connect: permission denied/,
    reason: "docker-permission",
  },
  {
    test: /cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|docker\.sock|econnrefused|dial unix/,
    reason: "docker-not-running",
  },
  {
    // What a registry says when a pull cannot be satisfied: the tag is absent,
    // or the package is private and the anonymous request was refused.
    //
    // `is not built` is Paco's own wording from a version that refused to pull
    // the default image at all. Nothing emits it any more, and it is kept
    // deliberately: a provisioning failure is flattened into
    // `sessions.lifecycleError` as a plain string, so a host upgraded from that
    // version still has stored errors phrased that way, and they should still
    // classify rather than fall through to "unknown".
    // Deliberately not a bare `unauthorized`: this matcher runs before the
    // GitHub auth one, and git says "unauthorized" too — a clone rejected by
    // GitHub would then be reported as a missing workspace image.
    test: /is not built|manifest unknown|manifest for .* not found|failed to resolve reference|no such image|pull access denied|denied: denied/,
    reason: "image-missing",
  },
  {
    test: /invalid username or token|authentication failed|could not read username|terminal prompts disabled|bad credentials|http 401|permission denied \(publickey\)/,
    reason: "repo-auth-failed",
  },
  {
    test: /repository not found|repository '.*' not found|could not read from remote repository|remote branch .* not found|http 404/,
    reason: "repo-not-found",
  },
  {
    test: /could not resolve host|network is unreachable|temporary failure in name resolution|connection (refused|reset|timed out)|tls handshake|i\/o timeout/,
    reason: "network",
  },
  {
    test: /command timed out|context deadline exceeded|etimedout/,
    reason: "timed-out",
  },
];

/**
 * Read a reason out of whatever Docker or git said.
 *
 * Only for text that arrived from a tool. A `ProvisioningError` already carries
 * its reason as a field and must never be routed through here — see
 * `classifySetupFailure`, which checks that first.
 */
export function classifySetupFailureText(
  text: string,
): ProvisioningFailureReason {
  const haystack = text.toLowerCase();

  // Checked before the matchers, and it is the only pattern here that keys on
  // something Paco wrote. `markSetupReason` stamps it onto every message that
  // already knew its own reason, and it is the one part of an error that
  // survives the durable workflow intact — see `provisioning-errors.ts` for
  // what the boundary actually does to a thrown object, and for why matching
  // a purpose-built token is not the same mistake as matching our own prose.
  //
  // It wins over the text matchers because the thrower knew more than the
  // reader can infer: a wrapper prefix can easily contain a word one of the
  // patterns below keys on, and the tag is immune to that.
  const marked = readMarkedSetupReason(haystack);
  if (marked) {
    return marked;
  }

  for (const matcher of MATCHERS) {
    if (matcher.test.test(haystack)) {
      return matcher.reason;
    }
  }

  return "unknown";
}

/**
 * A `DockerUnusableError` that has not crossed a boundary yet.
 *
 * `@paco/sandbox` cannot import this module and this module must not import
 * the sandbox package, so the class is recognised by `name` and its `state`
 * field is validated against the reason list rather than trusted. Name-based
 * duck typing rather than `instanceof` for the same reason `@workflow/core`
 * uses it: the workflow half of this app runs in a separate `vm` realm, where
 * `instanceof` against a host-realm class is false for an object that is
 * unmistakably one.
 *
 * This only fires in-process — inside the provisioning step itself, and in the
 * `/api/sandbox` route, which calls `classifySetupFailure` on an error it
 * caught directly. Once the workflow has flattened the throw there is no
 * object left to read, and the tag in the message is what answers.
 */
function dockerUnusableState(error: unknown): ProvisioningFailureReason | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  if ((error as { name?: unknown }).name !== "DockerUnusableError") {
    return null;
  }
  const state = (error as { state?: unknown }).state;
  return isProvisioningFailureReason(state) ? state : null;
}

/**
 * The reason behind any workspace-setup failure, however it arrived.
 *
 * Two things reach this function and they need opposite treatment. A
 * `ProvisioningError` decided its own reason and is trusted outright. Anything
 * else carries text that Docker or git wrote, which has to be read to mean
 * anything — and that text is the *only* thing that survives the trip through
 * the durable workflow. A provisioning failure is persisted to
 * `sessions.lifecycleError` as a plain string and rethrown in a later workflow
 * run as a plain `Error`, so the `reason` field is gone by the time anyone
 * needs it. Classifying on the far side is what carries the reason across that
 * boundary without adding a column.
 */
export function classifySetupFailure(
  error: unknown,
): ProvisioningFailureReason {
  const explicit = provisioningFailureReason(error);
  if (explicit) {
    return explicit;
  }

  const preflight = dockerUnusableState(error);
  if (preflight) {
    return preflight;
  }

  return classifySetupFailureText(
    error instanceof Error ? error.message : String(error),
  );
}
