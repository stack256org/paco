import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    // this module's hashing scheme: sha256 of the sorted per-file digests
    // `sha256(relPath + "\0" + bytes)`, joined with "\n". Pinning the
    // literal value catches an accidental change to the scheme itself, not
    // just a regression in determinism.
    expect(digest).toBe(
      "58906827106986b0a0c70d0fb5fd5a124024eed9669f559b10c1586399445190",
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

  test("rejects a tree containing a symlink", async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, "real.txt"), "hi");
    await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));

    await expect(hashDirectory(dir)).rejects.toThrow(/symlink/);
  });

  test("distinguishes trees that would collide under naive path+bytes concatenation", async () => {
    // Without per-file framing, hashing `path1 + "\0" + bytes1 + path2 +
    // "\0" + bytes2` is not injective: a file's *content* can contain the
    // literal bytes of the next file's "path\0" marker, letting bytes move
    // across a file boundary without changing the overall byte stream.
    //
    // Tree one: a.txt = "hello", b.txt = "b.txt\0" (6 raw bytes: the ASCII
    // text "b.txt" plus a NUL byte — ordinary binary file content).
    // Tree two: a.txt = "hello" + "b.txt\0" (the same 6 bytes appended),
    // b.txt = "" (empty).
    //
    // Concatenated naively, both produce the exact same overall byte
    // stream ("a.txt\0hellob.txt\0b.txt\0"), so a scheme without per-file
    // digests would hash them identically even though they are genuinely
    // different trees. The fixed scheme (hash each file first, then hash
    // the sorted per-file digests) must tell them apart.
    const markerBytes = Buffer.from("b.txt\0", "binary");

    const dirOne = await makeTmpDir();
    await writeFile(path.join(dirOne, "a.txt"), "hello");
    await writeFile(path.join(dirOne, "b.txt"), markerBytes);

    const dirTwo = await makeTmpDir();
    await writeFile(
      path.join(dirTwo, "a.txt"),
      Buffer.concat([Buffer.from("hello"), markerBytes]),
    );
    await writeFile(path.join(dirTwo, "b.txt"), Buffer.alloc(0));

    expect(await hashDirectory(dirOne)).not.toBe(await hashDirectory(dirTwo));
  });
});
