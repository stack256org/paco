import Docker from "dockerode";
import { pickSandboxContainerName } from "./reap.ts";

/**
 * The host-published port for one container port, on every currently
 * running Paco sandbox container, keyed by container name.
 *
 * A single bulk `listContainers` call rather than one `inspect()` per
 * container — this backs `syncPreviewRoutes`
 * (`apps/web/lib/preview/nginx-reload.ts`), which reconciles nginx's config
 * against every active session's sandbox and has no business making one
 * Docker API round trip per session. `listContainers`'s own `Ports` field
 * already carries what `DockerSandbox`'s private `#readPortBindings` reads
 * from a single container's `inspect()` — the same information, just
 * available in bulk here.
 *
 * Only running containers report a `PublicPort` at all, so a hibernated or
 * stopped sandbox's session is simply absent from the returned map — there
 * is nothing to route a preview to until it is running again.
 */
export async function listSandboxPreviewPorts(
  containerPort: number,
): Promise<Map<string, number>> {
  const docker = new Docker();
  const containers = await docker.listContainers({ all: false });

  const found = new Map<string, number>();
  for (const container of containers) {
    const name = pickSandboxContainerName(container.Names ?? []);
    if (!name) {
      continue;
    }

    const match = (container.Ports ?? []).find(
      (port) =>
        port.PrivatePort === containerPort &&
        port.Type === "tcp" &&
        typeof port.PublicPort === "number",
    );

    if (match?.PublicPort) {
      found.set(name, match.PublicPort);
    }
  }

  return found;
}
