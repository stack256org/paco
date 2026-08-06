/**
 * Create the durable workflow runtime's tables.
 *
 * Its bootstrap CLI reads `WORKFLOW_POSTGRES_URL`, falling back to a
 * `postgres://world:world@localhost:5432/world` database that exists nowhere.
 * Paco has one database, so this passes `POSTGRES_URL` through rather than
 * making an operator set a second URL that has to match the first — and a
 * mismatch there is quiet, because the tables get created somewhere real and
 * simply not where the app looks.
 *
 * Idempotent, and run as part of `db:migrate:apply` so a deploy applies both
 * sets of migrations together.
 *
 * Usage:  node scripts/workflow-bootstrap.ts
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { config } from "dotenv";

config({ path: join(import.meta.dirname, "..", ".env"), quiet: true });

const url = process.env.POSTGRES_URL?.trim();

if (!url) {
  console.error(
    "POSTGRES_URL is not set, so the workflow tables cannot be created.\n" +
      "Set it in apps/web/.env and run this again.",
  );
  process.exit(1);
}

// `bin/setup.js` is not listed in the package's `exports`, so it cannot be
// resolved directly. Resolve the entry point that is exported and walk up to
// the package root, which keeps this working under pnpm's nested layout.
const require = createRequire(import.meta.url);
const packageRoot = dirname(
  dirname(require.resolve("@workflow/world-postgres")),
);
const bootstrap = join(packageRoot, "bin", "setup.js");

const result = spawnSync(process.execPath, [bootstrap], {
  stdio: "inherit",
  env: { ...process.env, WORKFLOW_POSTGRES_URL: url },
});

process.exit(result.status ?? 1);
