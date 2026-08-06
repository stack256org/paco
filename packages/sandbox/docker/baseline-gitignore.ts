/**
 * The `.gitignore` written into a workspace that has none.
 *
 * This is not a convenience. Without it, the first dependency install makes
 * every file under `node_modules` an untracked file the diff viewer must read
 * and inline: a scaffolded Next.js app produced a 650,000-line diff that
 * exhausted the server's heap, and it carried binary build-cache files, which
 * Postgres rejects outright because JSON text cannot hold a NUL byte.
 *
 * Scope is deliberately "build output and secrets", not a language-by-language
 * catalogue. Anything a build regenerates is noise in review; anything in a
 * `.env` should never reach a remote. Lockfiles are intentionally absent — they
 * are committed, because a lockfile is the record of what was actually
 * installed.
 *
 * Only written when the workspace has no `.gitignore`, so a cloned repository's
 * own rules always win.
 */
export const BASELINE_GITIGNORE = `# Written by Paco because this workspace had no .gitignore.
# Edit freely — it will not be replaced.

# Dependencies
node_modules/
.pnpm-store/
.yarn/
bower_components/
vendor/

# Build output
dist/
build/
out/
.output/
target/

# Framework caches
.next/
.nuxt/
.svelte-kit/
.astro/
.docusaurus/
.parcel-cache/
.vite/
.turbo/

# Tests and coverage
coverage/
.nyc_output/
.pytest_cache/
playwright-report/
test-results/

# Python
__pycache__/
*.py[cod]
.venv/
venv/
*.egg-info/

# Secrets and local config
.env
.env.*
!.env.example
*.pem
*.key

# Logs
*.log
npm-debug.log*
pnpm-debug.log*
yarn-error.log*

# Editors and OS
.DS_Store
Thumbs.db
.idea/
*.swp
.vscode/*
!.vscode/extensions.json
`;
