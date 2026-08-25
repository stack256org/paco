# `@paco/plugin-host` — what containment actually means

This file is the authoritative statement of what running a third-party plugin
does and does not expose. The install-consent copy quotes it. **Do not let the
consent screen promise anything this file does not claim**, and do not add a
claim here that no test proves.

Plugin code runs in a separate OS process — never in the Next.js process, never
in a request handler. What follows describes that process.

Three adversarial reviews have found real escapes from earlier versions of this
design. All three are fixed and regression-tested. They are listed here rather
than buried, because the shape of a past escape is the best guide to what this
boundary is worth — and all three had the same shape.

| Escape | What it did | What it changed |
| --- | --- | --- |
| **Symlink read** | A plugin shipping `escape -> /` read `/etc/hosts`, Paco's source, and the operator's home directory — the permission model follows links that live under an allowed prefix. Reproduced on Node 26.7.0 with the allowlist correctly applied. | `start()` now refuses any plugin tree containing a symbolic link. |
| **`getBuiltinModule`** | `process.getBuiltinModule("node:net")` returned a working `net` on both 22.21.1 and 26.7.0, bypassing the module resolve hook entirely — it never goes through resolution. On 22.21.1 it opened a real TCP connection to the internet. | The accessor is now guarded, alongside `process.binding`. |
| **Socket-capable internals** | `_tls_wrap.connect(...)` and `import("_http_client")` gave a plugin holding **no network grant** a real TLS connection returning `HTTP/1.1 200 OK` on 22.21.1. `_tls_wrap`, `_http_client`, `_http_agent`, `_http_server`, `_http_outgoing`, `_http_common` and `_stream_wrap` were all reachable by both routes in both forms, and none were on the denylist. | Both gates became **allowlists**, and Node >= 24 became a hard floor. |

The common shape: containment expressed as a denylist of named things, against
a surface larger than any hand-maintained list. That is why the module gates
are allowlists now.

## Required runtime

**Hardened plugin workers require Node >= 24. The host refuses to start on
anything older** — `PluginHost.start()` reads the version of the binary you
pass as `nodeExecutable` and rejects with a clear error below 24, or when the
version cannot be read at all.

This is a hard floor, not a recommendation. Node >= 24 gates network sockets
inside the permission model, and that gate is the backstop behind everything in
this file. On Node 22.x there is no socket gate, so the in-process module
allowlist would be the *only* barrier between a plugin and the network — a
position three adversarial reviews have now shown to be one missed name away
from failing. **Node 22.x is out of support for hardened plugins.**

Node 22.15 remains the floor for the *preload itself* (the release with
synchronous `module.registerHooks`), and the test suite still exercises the
allowlist on a 22.x binary when one is installed, precisely because that is the
tier where it would have to stand alone. But the host will not run a plugin
there.

No `--allow-net` is ever passed, on any version.

The test suite says loudly which tiers it could not verify.

## Deployment requirements

These are operational, not advisory. Hardened plugin hosting does not work
without them.

1. **Node >= 24 must be available to the process that hosts plugins**, and
   **Paco's bundled Node must satisfy that floor**. If the shipped runtime is
   ever pinned below 24, hardened plugin hosting stops working entirely —
   every `start()` fails with the floor error rather than silently running
   unsandboxed. That is the intended failure mode.
2. **The embedder must pass `nodeExecutable`** pointing at that binary.
   `PluginHost` defaults to `process.execPath`, which under bun (and under any
   non-Node runtime) is refused by the floor check. The plugin registry owns
   this.
3. **`hardened` must be left at its default of `true`** everywhere real plugin
   code runs.
4. **CI should verify containment on the Node it ships.** The test suite prints
   which Node tiers it resolved and warns loudly for any it could not; a build
   that silently skips those tiers has not tested the sandbox. Set
   `PACO_NODE_EXECUTABLE` and fail the build if a tier is skipped.

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

The runtime's socket gate (Node >= 24) is the outer barrier. Inside it,
`worker-preload.ts` runs before any plugin code and confines what plugin code
can even reach:

1. `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource` are deleted from
   `globalThis`.
2. **Plugin code may load only an allowlist of builtins**: `assert`, `buffer`,
   `crypto`, `events`, `fs`, `fs/promises`, `path`, `querystring`, `stream`,
   `stream/promises`, `string_decoder`, `timers`, `timers/promises`, `url`,
   `util`, `zlib` — and their `node:` forms. **Nothing is denied by name.**
   Every other builtin is refused by default: `net` and `http`, the
   underscore-prefixed internals, modules nobody here has heard of, and
   builtins that future Node releases will add.

   Two entries are worth naming. `fs` is on the list and is harmless there,
   because Node's permission model confines it independently to the plugin's
   own directory and state directory. **`os` is deliberately NOT on the list**:
   it reaches no socket, but `os.networkInterfaces()` hands over the host's
   internal IP addresses and `os.userInfo()` its username, and either could
   later leave through a granted `net:fetch` domain. A plugin that genuinely
   needs platform information should get it through a capability, with consent,
   rather than by reading the host.
3. Both routes to a builtin are gated, because there are two and they are
   independent:
   - **Module resolution** — a synchronous resolve hook. It asks Node to
     resolve first and then checks the *resolved* url, so Node itself
     identifies what is a builtin; this file keeps no list of them.
   - **`process.getBuiltinModule(id)`** — which does *not* go through
     resolution and so is invisible to the hook. This is not defence in depth,
     it is load-bearing: on Node 22.21.1 a plugin used it to obtain a working
     `net` and open a real TCP connection to the internet.
   `process.binding` and `process._linkedBinding`, the deprecated back doors to
   the same native bindings, are neutralized too.
4. Specifiers are normalized before the check, and normalization fails
   **closed**: non-strings, anything containing whitespace or a control
   character, and malformed paths are refused rather than repaired. The input
   is never trimmed — `"node:fs "` is refused, not read as `"fs"`.

The guards install non-configurable, non-writable properties; plugin code can
neither reassign them nor `defineProperty` the originals back. Every claim in
this section is covered by a test, on each Node tier that is installed.

### Why an allowlist

Three adversarial reviews found three escapes here, and all three were the same
mistake: containment expressed as a denylist of named modules. Node's builtin
surface is larger than any hand-maintained list and grows every release. The
third review settled it — `_tls_wrap`, `_http_client`, `_http_agent`,
`_http_server`, `_http_outgoing`, `_http_common` and `_stream_wrap` are all
socket-capable, all were reachable by both routes in both forms, and none of
them were on the list. A plugin holding no network grant opened a TLS connection
and got back `HTTP/1.1 200 OK`.

Adding to the allowlist is a security decision. Justify it in a comment next to
the entry, and check the module cannot reach the network — directly, or by
handing out a handle that can.

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
- **The in-process allowlist is not the last line of defence, and must not be
  treated as one.** Three reviews found three routes around earlier denylist
  versions of it. It is now an allowlist, which closes that whole class rather
  than one instance — but it still lives in the same VM as the plugin, which is
  why the host refuses to run below Node 24, where the runtime's socket gate
  stands behind it.
- **A plugin can still see a little of the host.** `os` is off the allowlist,
  which closes the worst of it (internal IPs, usernames), but the `process`
  global is not a module and cannot be taken away: `process.platform`,
  `process.arch`, `process.version`, `process.pid` and `process.cwd()` are all
  readable. That is a small, deliberate residue — enough to fingerprint the
  platform, not enough to enumerate the network — and like anything a plugin
  learns, it can leave through a granted `net:fetch` domain.
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
plugin code runs. Setting it to `false` drops `--permission`, the network
preload, and the Node >= 24 floor check, leaving an ordinary process with full
filesystem and network access. It exists for one reason: this package's own
tests run under bun, which has no permission model.

The symlink refusal is **not** part of hardened mode — it runs in the host on
every start, in both modes.

Production must also pass `nodeExecutable` pointing at a real Node >= 24 (see
"Required runtime"). Under bun, `process.execPath` is bun, which reports major
version 1 and is refused by the floor check before any spawn happens.
