/**
 * Sandbox timeout and sizing configuration.
 * All timeout values are in milliseconds.
 */

/**
 * Safety buffer reserved for the sandbox's before-stop hooks (30 seconds).
 *
 * Subtracted from the lease so hooks get a chance to run before the sandbox is
 * torn down, rather than being cut off at the deadline.
 */
const SANDBOX_TIMEOUT_BUFFER_MS = 30 * 1000;

/**
 * How long a sandbox may live before the lifecycle workflow reclaims it.
 *
 * A Docker container has no platform-imposed expiry — nothing outside this app
 * will stop it — so these are the app's own reclamation windows, chosen to stop
 * forgotten containers from holding disk and memory indefinitely. The lifecycle
 * workflow hibernates idle sandboxes well before this (see
 * SANDBOX_INACTIVITY_TIMEOUT_MS); this is the outer bound.
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS =
  5 * 60 * 60 * 1000 - SANDBOX_TIMEOUT_BUFFER_MS;

/** Default vCPU allowance for new sandbox containers. */
export const DEFAULT_SANDBOX_VCPUS = 4;

/** Manual extension duration for explicit fallback flows (20 minutes) */
export const EXTEND_TIMEOUT_DURATION_MS = 20 * 60 * 1000;

/** Inactivity window before lifecycle hibernates an idle sandbox (30 minutes) */
export const SANDBOX_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** Buffer for sandbox expiry checks (10 seconds) */
export const SANDBOX_EXPIRES_BUFFER_MS = 10 * 1000;

/** Grace window before treating a lifecycle run as stale (2 minutes) */
export const SANDBOX_LIFECYCLE_STALE_RUN_GRACE_MS = 2 * 60 * 1000;

/** Minimum sleep between lifecycle workflow loop iterations (5 seconds) */
export const SANDBOX_LIFECYCLE_MIN_SLEEP_MS = 5 * 1000;

/**
 * Default ports published from a sandbox container.
 * Limited to 5 ports. Covers the most common framework defaults
 * plus the built-in code editor:
 * - 3000: Next.js, Express, Remix
 * - 5173: Vite, SvelteKit
 * - 4321: Astro
 * - 8000: a common fallback for Python and Django dev servers
 */
export const DEFAULT_SANDBOX_PORTS = [3000, 5173, 4321, 8000];

/**
 * Working directory inside the sandbox container, used for path display.
 *
 * Must match the container's `WORKDIR` (`CONTAINER_WORKDIR` in
 * `@paco/sandbox`). It is only a display fallback: tool paths are already
 * rewritten workspace-relative before they reach the client.
 */
export const DEFAULT_WORKING_DIRECTORY = "/workspace";

/**
 * Port a chat's preview is expected to be reachable on inside its sandbox.
 *
 * The first of `DEFAULT_SANDBOX_PORTS` — the port a freshly scaffolded
 * Next.js/Express/Remix app binds by default, and the one convention the
 * agent's own instructions steer it toward first. Each generated nginx
 * server block (`lib/preview/nginx-config.ts`) names exactly one backend
 * port per preview, so previewing a dev server on any of the other
 * published ports is out of scope for this phase.
 */
export const PREVIEW_PORT = DEFAULT_SANDBOX_PORTS[0];

/**
 * Port Paco's own service listens on, on the native install as much as the
 * Docker one.
 *
 * `packaging/debian/postinst` writes this same literal into `paco.env`
 * (`PORT=3000`) and into the default nginx site's `proxy_pass`. It is also
 * where every generated preview's `auth_request` subrequest is aimed
 * (`lib/preview/nginx-config.ts`) — see that file for why it has to be
 * `127.0.0.1:<this port>` and never the public origin.
 */
export const PACO_APP_PORT = 3000;
