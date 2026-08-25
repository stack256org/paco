# `@paco/plugin-host` — what containment actually means

This file is the authoritative statement of what running a third-party plugin
does and does not expose. The install-consent copy quotes it. **Do not let the
consent screen promise anything this file does not claim**, and do not add a
claim here that no test proves.

Plugin code runs in a separate OS process — never in the Next.js process, never
in a request handler. What follows describes that process.

Two adversarial reviews have found real escapes from earlier versions of this
design. Both are fixed and regression-tested; both are described below, because
the shape of a past escape is the best guide to what this boundary is worth.

## Required runtime

| | |
| --- | --- |
| **Minimum** | Node 22.15 — the release with synchronous `module.registerHooks` |
| **Recommended, and what production must pin** | **Node >= 24** |

The difference is not cosmetic. Node >= 24 gates network sockets inside the
permission model, so a plugin that somehow obtained a socket API still cannot
connect. **On Node 22.x there is no socket gate**, and the JavaScript-level
denial described below is the *only* barrier between a plugin and the network.
It is a good barrier — it is tested, and it holds against every route the
reviews found — but it lives in the same VM as the plugin, and that is a weaker
position than a runtime gate. No `--allow-net` is ever passed.

The containment test suite runs against both tiers when both are installed, and
says loudly which tiers it could not verify.

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

### A filesystem allowlist, plus a symlink rule that makes it mean something

The worker runs under Node's permission model (`--permission`) with an explicit
allowlist:

- **Readable:** the plugin's own directory; this package (the worker entry and
  its preload); the two packages the worker imports (`zod`, `@paco/plugin-kit`);
  the plugin's state directory.
- **Writable:** the plugin's state directory only —
  `<os.tmpdir()>/paco-plugins/<plugin-id>`.

Paths outside those prefixes fail with `ERR_ACCESS_DENIED` — verified for
`/etc/hosts` and for writes to `/tmp`.

**That allowlist is a path-prefix rule, and the permission model follows
symlinks that live under an allowed prefix.** A plugin shipping a single link,
`escape -> /`, is therefore granted the entire filesystem *through its own
directory* — reading `/etc/hosts`, Paco's own source, and the operator's home
directory. This was reproduced on Node 26.7.0 with the allowlist correctly
applied. The allowlist cannot express "but not through links".

So the host **refuses to start a plugin whose directory tree contains any
symbolic link**, at any depth, naming the offending path. The scan is bounded
in breadth (20,000 entries) and depth (24 levels), and exceeding either bound is
also a refusal. Every slot path is separately re-checked, after real-path
resolution, to be inside the plugin's real root.

A consequence worth knowing: a plugin directory cannot contain symlinked
`node_modules`. Plugin dependencies must be real files.

### No subprocesses, threads, or native code

`--allow-child-process`, `--allow-worker` and `--allow-addons` are deliberately
never passed. A plugin cannot shell out, cannot start a worker thread, and
cannot load a `.node` addon — each of which would step straight around
everything else here.

### No network except through a consented allowlist

On Node 22.x the permission model does not cover sockets, so the worker closes
that gap itself, in `worker-preload.ts`, before any plugin code loads. Four
layers, because the first two alone had a hole:

1. `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource` are deleted from
   `globalThis`.
2. A synchronous resolve hook refuses `net`, `http`, `https`, `http2`, `tls`,
   `dns`, `dgram`, `child_process`, `worker_threads`, `cluster`, `vm`,
   `inspector`, `repl`, `wasi` and `module` — in both prefixed and unprefixed
   forms — for any importer outside this package. `module` is on the list
   because without it a plugin could unregister the hook or build its own
   resolver.
3. **`process.getBuiltinModule` is replaced by a guarded version.** This one is
   not defence in depth — it is load-bearing. `getBuiltinModule` hands back a
   builtin *without going through module resolution*, so the resolve hook never
   sees it. On Node 22.21.1, under a correct `--permission` allowlist, a plugin
   used it to obtain a working `net` and **open a real TCP connection to the
   internet**. The replacement throws for the same denied list.
4. `process.binding` and `process._linkedBinding` — the deprecated back doors to
   the same native bindings — are neutralized.

Layers 3 and 4 install non-configurable, non-writable properties; plugin code
cannot `defineProperty` or assign the originals back. Both facts are tested.

The only sanctioned way out is the `net:fetch` capability. The host checks every
request against the **operator's consented domain list** (from the database,
never from the plugin's manifest): http(s) only, no IP literals, and an exact
hostname match — a grant for `api.linear.app` covers neither
`evil.api.linear.app` nor `linear.app`.

### Capability grants are enforced in the host

Every `capability-request` is checked against the granted list in the host
process, before any handler is looked up. The worker is untrusted and can ask
for anything; asking is not receiving. The granted list is intersected with the
plugin's manifest at construction, so a stale consent row cannot grant more than
the installed plugin declares.

### Protocol limits

| Limit | Value |
| --- | --- |
| Bytes in one protocol line | 65,536 (64 KiB) |
| Retained worker stderr | 16,000 bytes |
| Malformed messages before the worker is killed | 5 |
| In-flight capability requests | 32 |
| Worker log messages | 50/second |
| Registered tools per plugin | 64 |
| Tool name / description length | 64 / 1000 characters |
| Files / directory depth scanned at start | 20,000 / 24 |
| Ready handshake | 10s |
| One tool call | 30s (default) |
| Graceful shutdown before SIGKILL | 3s |

A worker that exceeds a protocol limit is killed and the plugin degrades: a
crashed plugin drops its subscriptions and its tools, and never fails the turn
that touched it. Kills target the worker's whole process group.

## What is NOT enforced

Be precise about this. The consent screen must not imply otherwise.

- **This is not a container.** There is no namespace, no cgroup, no seccomp
  filter, no chroot. A kernel-level escape from Node's permission model, or a
  bug in the permission model itself, is an escape from all of this.
- **A plugin can kill Paco.** The worker is a child process, so
  `process.kill(process.ppid, "SIGKILL")` reaches the host that spawned it, and
  nothing in-process can prevent that — the pid is readable and the signal is a
  syscall. Today this is a denial of service, not a data escape. The mitigations
  are structural, not code in this package: run workers under a **separate UID**
  whose signals cannot reach the host user's processes, and/or spawn them from a
  **supervisor that is not the serving process**, so killing the parent loses a
  plugin runner rather than the app. Neither is implemented.
- **No CPU or memory limit.** A plugin can spin a core and can allocate until the
  host OOMs. The timeouts above bound how long the *host waits*, not how long the
  worker runs; a hung worker is only actually killed at `stop()`. There is no
  disk quota on the state directory either.
- **The network denial is in-process on Node 22.x.** Two reviews have now found
  routes around parts of it, and both were fixed after the fact. On Node >= 24
  the runtime's socket gate stands behind it; on 22.x nothing does. Run >= 24,
  and do not run a plugin you believe to be actively malicious and expect the
  network to hold on 22.x.
- **SSRF is only half-prevented here.** The host checks the URL string. It cannot
  see where DNS resolves or where a redirect goes. The `net:fetch` handler is
  *required* to fetch with `redirect: "manual"`, re-check every hop with
  `isFetchAllowed`, and refuse resolved addresses that are private, loopback, or
  link-local — `169.254.169.254` is the cloud metadata endpoint.
- **A plugin sees everything it is given.** Capability grants are the whole
  security boundary at the data layer. `storage:kv` is per-plugin, but
  `events:subscribe` means the plugin receives session events, and
  `messages:post` means it can write into a chat. Consent to those is consent to
  the data they carry.
- **Plugin dependencies are the plugin.** Anything under the plugin's root is
  readable and loadable by it. Reviewing a plugin means reviewing what it
  vendors.

## The non-hardened mode

`PluginHostOptions.hardened` defaults to `true` and must stay true wherever real
plugin code runs. Setting it to `false` drops `--permission` and the network
preload entirely, leaving an ordinary process with full filesystem and network
access. It exists for one reason: this package's own tests run under bun, which
has no permission model.

The symlink refusal is **not** part of hardened mode — it runs in the host on
every start, in both modes.

Production must also pass `nodeExecutable` pointing at a real Node (see
"Required runtime"). Under bun, `process.execPath` is bun, which would reject
`--permission` outright.
