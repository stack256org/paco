# `@paco/plugin-host` — what containment actually means

This file is the authoritative statement of what running a third-party plugin
does and does not expose. The install-consent copy quotes it. **Do not let the
consent screen promise anything this file does not claim.**

Plugin code runs in a separate OS process — never in the Next.js process, never
in a request handler. What follows describes that process.

## What IS enforced

### No ambient secrets

The worker's environment is constructed from scratch, not filtered from the
host's. It contains exactly three variables:

| Variable | Why |
| --- | --- |
| `PATH` | Node needs it to start. |
| `PACO_PLUGIN_ID` | The plugin's own id. |
| `PACO_PLUGIN_STATE_DIR` | The plugin's scratch directory. |

`APP_SECRET`, `POSTGRES_URL`, `SMTP_PASSWORD` and every provider token are
absent because they were never put there. There is no denylist to get wrong.

### No filesystem beyond its own directory

The worker runs under Node's permission model (`--permission`) with an explicit
allowlist:

- **Readable:** the plugin's own directory; this package (the worker entry and
  its preload); the two packages the worker imports (`zod`, `@paco/plugin-kit`);
  the plugin's state directory.
- **Writable:** the plugin's state directory only —
  `<os.tmpdir()>/paco-plugins/<plugin-id>`.

Everything else — `/etc/hosts`, the repository, the operator's home directory,
another plugin's directory, the Postgres socket — fails with
`ERR_ACCESS_DENIED`. The worker's working directory is the plugin's own root.

### No subprocesses, threads, or native code

`--allow-child-process`, `--allow-worker` and `--allow-addons` are deliberately
never passed. A plugin cannot shell out, cannot start a worker thread, and
cannot load a `.node` addon — each of which would step straight around the
permission model.

### No network except through a consented allowlist

Node's permission model does **not** cover sockets, so the worker closes that
gap itself, in `worker-preload.ts`, before any plugin code loads:

- `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource` are deleted from
  `globalThis`.
- A synchronous resolve hook refuses `net`, `http`, `https`, `http2`, `tls`,
  `dns`, `dgram`, `child_process`, `worker_threads`, `cluster`, `vm`,
  `inspector`, `repl`, `wasi` and `module` — in both prefixed and unprefixed
  forms — for any importer outside this package. `module` is on the list
  because without it a plugin could unregister the hook or build its own
  resolver.

The only way out is the `net:fetch` capability. The host checks every request
against the **operator's consented domain list** (from the database, never from
the plugin's manifest): http(s) only, no IP literals, and an exact hostname
match — a grant for `api.linear.app` covers neither `evil.api.linear.app` nor
`linear.app`.

### Capability grants are enforced in the host

Every `capability-request` is checked against the granted list in the host
process, before any handler is looked up. The worker is untrusted and can ask
for anything; asking is not receiving. The granted list is intersected with the
plugin's manifest at construction, so a stale consent row cannot grant more
than the installed plugin declares.

### Nothing is unbounded

| Limit | Value |
| --- | --- |
| Bytes in one protocol line | 64,000 |
| Retained worker stderr | 16,000 bytes |
| Malformed messages before the worker is killed | 5 |
| In-flight capability requests | 32 |
| Worker log messages | 50/second |
| Registered tools per plugin | 64 |
| Tool name / description length | 64 / 1000 characters |
| Ready handshake | 10s |
| One tool call | 30s (default) |
| Graceful shutdown before SIGKILL | 3s |

A worker that exceeds a protocol limit is killed and the plugin degrades: a
crashed plugin drops its subscriptions and its tools, and never fails the turn
that touched it. Kills target the worker's whole process group.

## What is NOT enforced

Be precise about this. The consent screen must not imply otherwise.

- **This is not a container.** There is no namespace, no cgroup, no seccomp
  filter, no chroot. A kernel-level escape from Node's permission model is an
  escape from all of this.
- **No CPU or memory limit.** A plugin can spin a core and can allocate until
  the host OOMs. Timeouts bound how long the *host* waits, not how long the
  worker runs, and a hung worker is only killed at `stop()`.
- **No disk quota.** The state directory is unbounded.
- **The network denial is in-process.** It is a strong barrier against ordinary
  and moderately determined code, but it is not a kernel firewall. Anything
  that reaches a raw syscall — a native addon, were one loadable; a Node
  internals bug — is outside it. Do not run a plugin you believe to be
  actively malicious and expect the network to hold.
- **SSRF is only half-prevented here.** The host checks the URL string. It
  cannot see where DNS resolves or where a redirect goes. The `net:fetch`
  handler is *required* to fetch with `redirect: "manual"`, re-check every hop
  with `isFetchAllowed`, and refuse resolved addresses that are private,
  loopback, or link-local — `169.254.169.254` is the cloud metadata endpoint.
- **A plugin sees everything it is given.** Capability grants are the whole
  security boundary at the data layer. `storage:kv` is per-plugin, but
  `events:subscribe` means the plugin receives session events, and
  `messages:post` means it can write into a chat. Consent to those is consent
  to the data they carry.
- **Plugin dependencies are the plugin.** Anything under the plugin's root is
  readable and loadable by it. Reviewing a plugin means reviewing what it
  vendors.

## The non-hardened mode

`PluginHostOptions.hardened` defaults to `true` and must stay true wherever real
plugin code runs. Setting it to `false` drops `--permission` and the network
preload entirely, leaving an ordinary process with full filesystem and network
access. It exists for one reason: this package's own tests run under bun, which
has no permission model. Production must also pass `nodeExecutable` pointing at
a real Node binary (>= 22.15, for the synchronous `module.registerHooks`).
