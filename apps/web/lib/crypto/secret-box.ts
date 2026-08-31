import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { findConfigProblems } from "@/lib/config/required-env";

/**
 * Symmetric encryption for secrets Paco has to store and later replay.
 *
 * A GitHub token is the motivating case: it must be handed to `gh` on every
 * call, so it cannot be hashed — it has to come back out. Storing it in plain
 * text would mean a database dump, a stray backup, or a `select *` in a log
 * hands over the user's GitHub account.
 *
 * AES-256-GCM rather than CBC or CTR because it authenticates as well as
 * encrypts: a ciphertext altered in the database fails to decrypt instead of
 * quietly producing different bytes.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Version prefix on every ciphertext.
 *
 * Present so the scheme can be changed later without guessing at what old rows
 * contain — a value that does not start with a known version is rejected
 * rather than decrypted with the wrong assumptions.
 */
const VERSION = "v1";

/**
 * Domain separator for the derived key.
 *
 * `APP_SECRET` also signs sessions. Deriving a distinct key per purpose means
 * a flaw that exposes one use does not hand over the other.
 */
const KEY_INFO = "paco:secret-box:v1";

/**
 * Cached on `globalThis`, and deliberately.
 *
 * scrypt is slow by design; deriving per call would put ~100ms on every
 * request that touches a token. A module-level cache would not survive a
 * Turbopack rebuild in development, which is the same trap that leaked a
 * database pool per edit until Postgres refused new connections.
 *
 * Keyed by the domain separator, so every caller of `deriveAppKey` below —
 * not only this module's own `key()` — shares one cache without their
 * derived keys colliding with each other.
 */
const globalForKey = globalThis as typeof globalThis & {
  __pacoDerivedKeys?: Map<string, Buffer>;
};

/**
 * Derive a purpose-specific key from `APP_SECRET`.
 *
 * Exported so other modules that need a key derived from the same root
 * secret go through the same guard and the same cache as `seal`/`open`,
 * rather than re-deriving their own from the raw secret. `info` is the
 * domain separator (see `KEY_INFO` below): different callers must use
 * different values, or a flaw in one use's key exposes the other's.
 */
export function deriveAppKey(info: string): Buffer {
  if (!globalForKey.__pacoDerivedKeys) {
    globalForKey.__pacoDerivedKeys = new Map();
  }
  const cache = globalForKey.__pacoDerivedKeys;
  const cached = cache.get(info);
  if (cached) {
    return cached;
  }

  /*
   * The same rule the boot check applies, enforced again at the point of use.
   *
   * `findConfigProblems` refuses to start the app with a short or missing
   * secret, so in practice this never fires — but it is the function that
   * turns a secret into an encryption key, and it should not be willing to
   * derive one from "hunter2" just because it was called from somewhere that
   * skipped the check. A script, a test, or a future entry point would
   * otherwise encrypt real tokens under a guessable key and store them
   * looking exactly like the real thing.
   */
  const problem = findConfigProblems(process.env).find(
    (candidate) => candidate.variable === "APP_SECRET",
  );
  if (problem) {
    throw new Error(
      `APP_SECRET is unusable: ${problem.problem} ${problem.fix}`,
    );
  }

  const secret = process.env.APP_SECRET as string;

  // The salt is fixed rather than random: the same key must be derived on
  // every process start, or previously stored secrets become unreadable.
  // scrypt's cost, not salt uniqueness, is what protects a single high-entropy
  // application secret here.
  const derived = scryptSync(secret, info, KEY_LENGTH);
  cache.set(info, derived);
  return derived;
}

function key(): Buffer {
  return deriveAppKey(KEY_INFO);
}

/** Encrypt a secret for storage. Returns an opaque, self-describing string. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a sealed secret.
 *
 * Throws on anything that is not intact and authentic: a truncated value, a
 * tampered ciphertext, or one sealed under a different `APP_SECRET`. Callers
 * should treat a throw as "this secret is gone" and ask the user to supply it
 * again, rather than retrying.
 */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed sealed secret");
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts as [
    string,
    string,
    string,
    string,
  ];

  const expected = Buffer.from(VERSION);
  const actual = Buffer.from(version);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`Unsupported sealed secret version: ${version}`);
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Malformed sealed secret");
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf-8");
}
