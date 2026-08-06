import { requireAdmin } from "@/lib/admin/require-admin";
import { NOT_YOURS, SIGNED_OUT } from "@/lib/error-copy";

/**
 * Restart the paco.service unit.
 *
 * A domain saved in Settings only reaches better-auth's trusted-host list when
 * the process starts, so "save" alone leaves the instance in a state where the
 * new address is configured but not yet honoured. Rather than explain that,
 * the settings page offers the restart.
 *
 * This used to shell out to `docker restart <container>`, from when Paco
 * itself ran as a Docker container. That deployment path is gone — the
 * native `.deb` (packaging/) is the only way Paco runs now, as the `paco`
 * systemd unit — so this always hit the "cannot tell which container it is
 * running in" branch: `HOSTNAME` is a Docker convention, and nothing sets it
 * for a systemd service. `paco` runs unprivileged, so restarting its own
 * unit needs the same narrow, validated sudoers grant
 * `packaging/debian/postinst` already installs for nginx's test-and-reload
 * (see apps/web/lib/preview/nginx-reload.ts) — one more NOPASSWD line, no
 * shell, no argument to smuggle anything through.
 *
 * The request is answered *before* the restart is issued: systemd stops this
 * process to restart it, so a response written afterwards would never arrive
 * and the browser would show a network error for an action that worked.
 */
export async function POST(): Promise<Response> {
  // Route handlers get no error interceptor in this app, so an admin check
  // that only throws would let a non-admin's request fall through Next's
  // generic 500 instead of the `{ error }` shape this route's caller relies
  // on. Catch it here and answer in that shape ourselves.
  try {
    await requireAdmin();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === SIGNED_OUT) {
      return Response.json({ error: SIGNED_OUT }, { status: 401 });
    }
    return Response.json({ error: NOT_YOURS }, { status: 403 });
  }

  // Detached: the process must not be waiting on a command that kills it.
  setTimeout(() => {
    void import("node:child_process").then(({ spawn }) => {
      const child = spawn(
        "sudo",
        ["-n", "/usr/bin/systemctl", "restart", "paco.service"],
        { detached: true, stdio: "ignore" },
      );

      // `stdio: "ignore"` means nobody is reading stdout/stderr, but `error`
      // and `exit` still fire. Without an `error` listener, a missing `sudo`
      // binary would make the child emit `error`, which EventEmitter re-throws
      // when nothing is listening — and because this runs inside a
      // `setTimeout`, that throw is uncaught and takes the whole server down
      // over a restart button.
      child.on("error", (error) => {
        console.error(
          `paco: could not run \`sudo systemctl restart paco.service\`: ${error.message}. Restart it from the host with \`paco restart\`.`,
        );
      });
      child.on("exit", (code, signal) => {
        if (code !== 0) {
          console.error(
            `paco: \`sudo systemctl restart paco.service\` exited ${code ?? `signal ${signal}`}. Restart it from the host with \`paco restart\`.`,
          );
        }
      });

      child.unref();
    });
  }, 500);

  return Response.json({ restarting: true });
}
