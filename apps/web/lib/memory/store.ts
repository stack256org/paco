import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface MemoryEntry {
  slug: string;
  title: string;
  updatedAt: string;
  source: "distilled" | "manual" | "promoted";
  body: string;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;
const VALID_SOURCES: ReadonlySet<string> = new Set([
  "distilled",
  "manual",
  "promoted",
]);

/** Kebab-case a title into a filesystem-safe, path-traversal-safe slug. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function quoteYamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteYamlString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Render a memory entry to markdown-with-frontmatter.
 *
 * Format (binding, see the plan's Global Constraints): YAML frontmatter with
 * `title`, `updatedAt` (ISO date), `source`, followed by a blank line and the
 * body. `slug` is not stored in the file — it is the filename.
 */
export function renderMemoryFile(
  entry: Pick<MemoryEntry, "title" | "updatedAt" | "source" | "body">,
): string {
  const frontmatter = [
    "---",
    `title: ${quoteYamlString(entry.title)}`,
    `updatedAt: ${quoteYamlString(entry.updatedAt)}`,
    `source: ${entry.source}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${entry.body}`;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/;

/** Parse a rendered memory file back into an entry, or `undefined` if it isn't one. */
export function parseMemoryFile(
  content: string,
  slug: string,
): MemoryEntry | undefined {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return;
  }
  const [, frontmatterBlock, body] = match;
  const fields: Record<string, string> = {};
  for (const line of (frontmatterBlock ?? "").split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    fields[key] = unquoteYamlString(rawValue);
  }

  const { title, updatedAt, source } = fields;
  if (!(title && updatedAt && source && VALID_SOURCES.has(source))) {
    return;
  }

  return {
    slug,
    title,
    updatedAt,
    source: source as MemoryEntry["source"],
    body: body ?? "",
  };
}

/**
 * List every memory entry in `dir`.
 *
 * A missing directory is not an error — it means nothing has been written
 * there yet. A file that fails to parse is skipped and logged rather than
 * failing the whole list: memory is additive context and must never block a
 * turn (see the plan's memory invariants).
 */
export async function listMemory(dir: string): Promise<MemoryEntry[]> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries: MemoryEntry[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith(".md")) {
      continue;
    }
    const slug = filename.slice(0, -".md".length);
    const filePath = path.join(dir, filename);

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      console.error(`[memory] failed to read ${filePath}:`, error);
      continue;
    }

    const entry = parseMemoryFile(content, slug);
    if (!entry) {
      console.error(`[memory] skipping unparseable memory file: ${filePath}`);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Write a memory entry to `dir`, creating it if needed.
 *
 * The slug is derived from the title, so writing the same title twice is an
 * update (overwritten body, bumped `updatedAt`) rather than a duplicate.
 */
export async function writeMemory(
  dir: string,
  entry: { title: string; body: string; source: MemoryEntry["source"] },
): Promise<{ slug: string }> {
  await fs.mkdir(dir, { recursive: true });
  const slug = slugify(entry.title);
  const content = renderMemoryFile({
    title: entry.title,
    updatedAt: new Date().toISOString(),
    source: entry.source,
    body: entry.body,
  });
  await fs.writeFile(path.join(dir, `${slug}.md`), content, "utf8");
  return { slug };
}

/**
 * Delete a memory entry by slug.
 *
 * The slug is validated against `^[a-z0-9-]+$` before any filesystem
 * operation — it can originate from user input (a settings page delete
 * action), and an unvalidated slug could otherwise be used to escape `dir`
 * (e.g. `../../etc/passwd`).
 */
export async function deleteMemory(
  dir: string,
  slug: string,
): Promise<boolean> {
  if (!SLUG_PATTERN.test(slug)) {
    return false;
  }
  try {
    await fs.unlink(path.join(dir, `${slug}.md`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
