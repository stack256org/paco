# Code Style & Patterns

Detailed coding conventions, tool implementation patterns, and common patterns for the Paco codebase.

## Package Manager

- Use **pnpm exclusively** for dependency management
- The monorepo uses `pnpm@11.17.0` through Corepack
- Use Node 24's built-in TypeScript support for utility scripts
- Use Bun only as the test runner

## TypeScript Configuration

- Strict mode enabled
- Target: ESNext with module "Preserve"
- `noUncheckedIndexedAccess: true` - always check indexed access
- `verbatimModuleSyntax: true` - use explicit type imports

## Formatting (Ultracite — oxfmt)

- Indent: 2 spaces
- Quote style: double quotes for JavaScript/TypeScript
- Run `pnpm fix` before committing

## Naming Conventions

- **Files**: kebab-case (e.g., `deep-agent.ts`, `paste-blocks.ts`)
- **Types/Interfaces**: PascalCase (e.g., `TodoItem`, `AgentContext`)
- **Functions/Variables**: camelCase (e.g., `getSandbox`, `workingDirectory`)
- **Constants**: UPPER_SNAKE_CASE for true constants (e.g., `TIMEOUT_MS`, `SAFE_COMMAND_PREFIXES`)

## Imports

- **Do NOT use `.js` extensions** in imports (e.g., `import { foo } from "./utils"` not `"./utils.js"`)
  - The `.js` extension causes module resolution issues with Next.js/Turbopack
  - This applies to all packages and apps in the monorepo
- Use explicit `.ts` extensions in modules loaded directly by Node 24 utility scripts
- Prefer named exports over default exports
- Group imports: external packages first, then internal packages, then relative imports
- Use type imports when importing only types: `import type { Foo } from "./types"`

## Types

- **Never use `any`** - use `unknown` and narrow with type guards
- Define schemas with Zod, then derive types: `type Foo = z.infer<typeof fooSchema>`
- Prefer interfaces for object shapes, types for unions/intersections
- Export types alongside their related functions

## Error Handling

- Return structured error objects rather than throwing when possible:
  ```typescript
  return { success: false, error: `Failed to read file: ${message}` };
  ```
- When catching errors, extract message safely:
  ```typescript
  const message = error instanceof Error ? error.message : String(error);
  ```
- Use descriptive error messages that include context (tool name, file path, etc.)

## Testing

- Use Bun's test runner: `import { test, expect } from "bun:test"`
- Test files use `.test.ts` suffix
- Colocate tests with source files

## Runtime APIs

- Use Node APIs for utility scripts
- Use Bun APIs only in tests when the Bun test runner requires them

## Tools and approvals

Paco defines no tools and runs no agent loop. Claude Code owns both: it decides
which of its own built-in tools to call, and Paco drives it headlessly and maps
its streaming JSON to UI chunks. There is no `packages/agent`, no `ToolLoopAgent`
and no `experimental_context` — if you are looking for where a tool is
implemented, it is inside the Claude Code CLI, not this repository.

What Paco does own is the **approval gate**. The CLI runs with its own prompts
bypassed, so `packages/claude-code/approval-policy.ts` decides what is allowed to
run unattended and what has to ask. Only genuinely irreversible actions ask:
force-pushing, deleting a remote branch, deleting a repository, `sudo`, `mkfs`,
piping a download into a shell, publishing a package, and recursive deletes that
reach outside the chat's own worktree.

Adding a tool name or a dangerous command pattern means editing that file **and**
adding a test. An unrecognised tool asks the user, which is safe but noisy; a
missing dangerous-command pattern is silent, which is not.

## Common Patterns

### Large UI files

- In already-large React view/page/client components, do **not** add new feature-specific state, effects, network calls, and JSX inline by default.
- Extract feature logic into a colocated hook (for example `use-dev-server.ts`) and extract self-contained UI regions into a colocated component (for example `dev-server-menu-items.tsx`).
- Keep the parent view responsible for shared capability flags and long-lived page state; pass the extracted feature controls down as props.
- If the feature state must survive menu/popover/dialog open-state changes, mount the hook in the parent view and pass its controls into the extracted child component instead of mounting the hook inside ephemeral UI content.

### Workspace Dependencies

Use `workspace:*` for internal packages:
```json
{
  "dependencies": {
    "@paco/sandbox": "workspace:*"
  }
}
```

### Catalog Dependencies

Use `catalog:` for shared external versions:
```json
{
  "dependencies": {
    "ai": "catalog:",
    "zod": "catalog:"
  }
}
```
