import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

/*
 * Which durable-workflow world to build against — fixed here, not configurable.
 *
 * `withWorkflow` reads this from the environment and, finding nothing, defaults
 * to the SDK's file-backed "local" world under `.next/workflow-data`. Paco runs
 * on Postgres and always will: `instrumentation.ts` constructs the world
 * explicitly from `POSTGRES_URL`, so an environment variable here could only
 * ever disagree with the runtime, never usefully change it.
 *
 * Assigned before `withWorkflow` is called, because it reads the variable while
 * the config module is evaluated.
 */
process.env.WORKFLOW_TARGET_WORLD = "@workflow/world-postgres";

/*
 * The same database, under the name the SDK looks for.
 *
 * Having chosen the Postgres world above, `withWorkflow` connects to it while
 * the config is evaluated, and it finds the connection string by reading
 * `WORKFLOW_POSTGRES_URL`. Paco deliberately keeps one URL in the environment,
 * so that variable is not set — and the SDK's fallback is
 * `postgres://world:world@localhost:5432/world`, a database that exists
 * nowhere. Every start logged a `FATAL: password authentication failed for
 * user "world"` between "workflows build complete" and the first request.
 *
 * Nothing downstream broke, which is why it survived: `instrumentation.ts`
 * builds the runtime world explicitly and correctly. This is the build step
 * alone, failing loudly and being ignored.
 *
 * Copied rather than exported, and read from `process.env` directly because
 * `.env` is already loaded by the time this module is evaluated and importing
 * `@/lib/db/url` here would pull server-only code into the config.
 */
if (!process.env.WORKFLOW_POSTGRES_URL && process.env.POSTGRES_URL) {
  process.env.WORKFLOW_POSTGRES_URL = process.env.POSTGRES_URL;
}

const nextConfig: NextConfig = {
  // The native `.deb` package (packaging/build-deb.sh) stages
  // `.next/standalone` rather than the whole repository with its
  // `node_modules` — the old, now-deleted Docker image took the latter, but
  // that trade was a container-image concern, not a package's: a `.deb`
  // that ran `pnpm install` worth of `node_modules` through `dpkg` would be
  // enormous and mostly dev-only.
  output: "standalone",
  /*
   * Belt-and-braces, not the primary defense — read packaging/build-deb.sh
   * first if you're here because a database route 500'd.
   *
   * Turbopack's build-time tracer, on this codebase, sometimes omits real
   * runtime dependencies from `.next/standalone`'s own `node_modules` copy.
   * Verified by running `.next/standalone` fully isolated from this repo's
   * own `node_modules` (`rsync -a --copy-links` into a scratch directory,
   * then `node server.js` there): it started, but every database-touching
   * route 500'd, because `drizzle-orm` and `postgres` were silently missing
   * despite `lib/db/client.ts` importing both directly and unconditionally.
   * Turbopack also warns about this during the build ("Encountered
   * unexpected file in NFT list … the whole project was traced
   * unintentionally") when it happens — `turbopackIgnore` comments on the
   * dynamic filesystem calls it points at (`workspaceRoot()` in
   * packages/sandbox/docker/connect.ts; the PATH lookup in
   * lib/github/gh-installed.ts) silence *that specific warning* most of the
   * time, but which packages actually end up missing from the copy still
   * varies build to build — the warning and the missing-package set are not
   * reliably the same event.
   *
   * `outputFileTracingIncludes` runs as a fixed step *after* Turbopack's
   * trace (see `collect-build-traces.js`), so it survives that fallback for
   * these two specific packages — useful if something outside this repo's
   * own packaging ever runs `next start` straight off `.next/standalone`.
   * It is not what makes the shipped `.deb` correct, though: build-deb.sh
   * replaces `.next/standalone`'s entire `node_modules` with a real one
   * from `pnpm deploy` regardless of what Turbopack traced, because the set
   * of packages this whitelist would need kept changing between builds.
   * See that script's comments, and
   * .superpowers/sdd/2026-08-05-native-installation/task-12-report.md, for
   * the full investigation.
   */
  outputFileTracingIncludes: {
    "/**": ["node_modules/drizzle-orm/**", "node_modules/postgres/**"],
  },
  // No `images.remotePatterns`: the only entry was
  // `avatars.githubusercontent.com`, allowed when signing in meant signing in
  // with GitHub and the session carried that account's avatar. There is no
  // sign-in of any kind now, no avatar URL is ever stored, and nothing
  // renders a remote image.
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // TypeScript 7 dropped the compiler API Next.js links against, so type
    // checking during the build has to go through the `tsc` CLI instead.
    useTypeScriptCli: true,
  },
};

export default withWorkflow(nextConfig);
