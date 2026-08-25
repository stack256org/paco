import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { hashDirectory } from "./content-hash";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paco-content-hash-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tmpDirs = [];
});

describe("hashDirectory", () => {
  test("produces a stable hex digest for a known fixture tree", async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, "a.txt"), "hello");
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "b.txt"), "world");

    const digest = await hashDirectory(dir);

    // Known-good digest for { "a.txt": "hello", "sub/b.txt": "world" } under
    // this module's hashing scheme (sorted "path\0bytes" concatenation).
    // Pinning the literal value catches an accidental change to the scheme
    // itself, not just a regression in determinism.
    expect(digest).toBe(
      "e7842a5b856fa71e09aedbebe8db61ec181bbaf9878421bacfd2dc6843b53ded",
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is independent of file creation order", async () => {
    const dirA = await makeTmpDir();
    await mkdir(path.join(dirA, "nested"), { recursive: true });
    await writeFile(path.join(dirA, "one.txt"), "1");
    await writeFile(path.join(dirA, "nested", "two.txt"), "2");
    await writeFile(path.join(dirA, "zzz.txt"), "3");

    const dirB = await makeTmpDir();
    await writeFile(path.join(dirB, "zzz.txt"), "3");
    await mkdir(path.join(dirB, "nested"), { recursive: true });
    await writeFile(path.join(dirB, "nested", "two.txt"), "2");
    await writeFile(path.join(dirB, "one.txt"), "1");

    expect(await hashDirectory(dirA)).toBe(await hashDirectory(dirB));
  });

  test("skips .git directories entirely", async () => {
    const dirWithoutGit = await makeTmpDir();
    await writeFile(path.join(dirWithoutGit, "plugin.json"), "{}");

    const dirWithGit = await makeTmpDir();
    await writeFile(path.join(dirWithGit, "plugin.json"), "{}");
    await mkdir(path.join(dirWithGit, ".git", "objects"), { recursive: true });
    await writeFile(
      path.join(dirWithGit, ".git", "HEAD"),
      "ref: refs/heads/main",
    );
    await writeFile(
      path.join(dirWithGit, ".git", "objects", "deadbeef"),
      "some git object content",
    );

    expect(await hashDirectory(dirWithGit)).toBe(
      await hashDirectory(dirWithoutGit),
    );
  });

  test("hashes nested directories at multiple depths", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "a", "b", "c"), { recursive: true });
    await writeFile(path.join(dir, "a", "b", "c", "deep.txt"), "deep");
    await writeFile(path.join(dir, "top.txt"), "top");

    const digestBefore = await hashDirectory(dir);

    // Changing a deeply nested file's bytes must change the digest.
    await writeFile(path.join(dir, "a", "b", "c", "deep.txt"), "changed");
    const digestAfter = await hashDirectory(dir);

    expect(digestBefore).not.toBe(digestAfter);
  });
});
