#!/usr/bin/env node
// Replace one of Turbopack's externalized native-module directories
// (.next/node_modules/<pkg>-<hash>/) with a complete, self-contained copy of
// that package and its full runtime dependency closure.
//
// Why this exists: Turbopack decides a handful of packages (native modules,
// mostly — on this codebase, `pg`, `cpu-features`, `typescript`, `shiki`)
// should be `require()`d at runtime instead of bundled, and leaves each one
// at `.next/node_modules/<pkg>-<hash>/` for the compiled chunks to find by
// that exact name. What ends up there varies build to build: sometimes a
// real copy of the package's own files without its dependencies (so `pg`
// fails on "Cannot find module 'pg-types'"), sometimes a symlink straight
// into this *repo's* node_modules (`../../../../node_modules/.pnpm/...`) —
// which is a dangling symlink the instant this directory is copied
// somewhere else, e.g. into a .deb. Both were reproduced by booting
// .next/standalone fully isolated from this repo's own node_modules; see
// packaging/build-deb.sh and
// .superpowers/sdd/2026-08-05-native-installation/task-12-report.md.
//
// Either way, the fix is the same: read the package's real name/version
// through whatever currently sits at this path (symlink or not — this must
// run before anything that entry might point at gets deleted), resolve
// that package and its full dependency closure fresh from this repo's real
// node_modules using Node's own resolver (correct regardless of pnpm's
// nested-scope layout, unlike re-implementing pnpm's own algorithm), and
// replace the directory outright with dereferenced, portable copies —
// nothing left pointing outside itself.
//
// Usage: node flatten-closure.mjs <externalizedPackageDir> <pnpmScopeDir>
//
// <externalizedPackageDir>  The directory to replace in place, e.g.
//                           .../.next/node_modules/pg-<hash>. Must still
//                           have a readable package.json (symlink or real
//                           copy) when this runs.
// <pnpmScopeDir>            That package's own resolution scope in the real
//                           pnpm store, e.g.
//                           node_modules/.pnpm/pg@8.20.0/node_modules —
//                           where its direct dependencies actually resolve
//                           from.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Trailing slash stripped: with one, `fs.rmSync` on a path that is itself a
// symlink to a directory removes the *target's contents* rather than the
// symlink node — verified directly. Every caller of this script passes a
// directory-glob match (`"$dir"/*/`), which always has one.
const [rawPkgDir, scopeDir] = process.argv.slice(2);
const pkgDir = rawPkgDir.replace(/\/+$/, "");
const req = createRequire(path.join(scopeDir, "noop.js"));

function packageRootFor(resolvedEntry, name) {
  // Walk up from the resolved entry file to the directory whose
  // package.json declares this package name — handles subpath exports
  // (e.g. "drizzle-orm/postgres-js") resolving inside a nested dist file.
  let dir = path.dirname(resolvedEntry);
  for (;;) {
    const pkgJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      if (pkg.name === name) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find package root for ${name} from ${resolvedEntry}`,
      );
    }
    dir = parent;
  }
}

// Read through whatever currently sits at pkgDir (symlink or real
// directory) *before* replacing anything.
const rootName = JSON.parse(
  fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
).name;

const seen = new Map(); // name -> resolved root dir (real, in the pnpm store)
const queue = [{ name: rootName, from: scopeDir }];

while (queue.length > 0) {
  const { name, from } = queue.shift();
  if (seen.has(name)) {
    continue;
  }

  let entry;
  try {
    entry = req.resolve(name, { paths: [from] });
  } catch (error) {
    console.error(
      `flatten-closure: could not resolve ${name} from ${from}: ${error.message}`,
    );
    continue;
  }

  const root = packageRootFor(entry, name);
  seen.set(name, root);

  const depPkgJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const deps = {
    ...depPkgJson.dependencies,
    ...depPkgJson.optionalDependencies,
  };
  for (const dep of Object.keys(deps)) {
    if (!seen.has(dep)) {
      queue.push({ name: dep, from: root });
    }
  }
}

const rootPackageDir = seen.get(rootName);
if (!rootPackageDir) {
  throw new Error(`Could not resolve the package being replaced: ${rootName}`);
}

// Replace pkgDir itself with a dereferenced copy of the real package...
fs.rmSync(pkgDir, { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });
execFileSync("cp", ["-RL", `${rootPackageDir}/.`, pkgDir]);

// ...then its full dependency closure, flattened into pkgDir/node_modules.
const targetNodeModules = path.join(pkgDir, "node_modules");
fs.mkdirSync(targetNodeModules, { recursive: true });
for (const [name, root] of seen) {
  if (name === rootName) {
    continue;
  }
  const dest = path.join(targetNodeModules, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync("cp", ["-RL", root, dest]);
}

console.error(
  `flatten-closure: ${rootName} -> ${seen.size} package(s), rooted at ${pkgDir}`,
);
