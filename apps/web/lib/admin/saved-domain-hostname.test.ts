import { describe, expect, test } from "bun:test";
import { hostnameFromSavedDomain } from "./saved-domain-hostname";

describe("hostnameFromSavedDomain", () => {
  test("strips the scheme from a saved origin", () => {
    expect(hostnameFromSavedDomain("https://paco.example.com")).toBe(
      "paco.example.com",
    );
    expect(hostnameFromSavedDomain("http://paco.example.com")).toBe(
      "paco.example.com",
    );
  });

  test("strips a port and a path, which certbot must not receive", () => {
    // `/etc/letsencrypt/live/<name>` and `certbot -d <name>` both want a bare
    // hostname; a port would make the path wrong and the -d argument invalid.
    expect(hostnameFromSavedDomain("https://paco.example.com:8443")).toBe(
      "paco.example.com",
    );
    expect(hostnameFromSavedDomain("https://paco.example.com/settings")).toBe(
      "paco.example.com",
    );
  });

  test("tolerates surrounding whitespace", () => {
    expect(hostnameFromSavedDomain("  https://paco.example.com  ")).toBe(
      "paco.example.com",
    );
  });

  test("lowercases the host", () => {
    expect(hostnameFromSavedDomain("https://PACO.Example.COM")).toBe(
      "paco.example.com",
    );
  });

  test("treats absent, empty, and whitespace-only as no domain", () => {
    expect(hostnameFromSavedDomain(null)).toBeNull();
    expect(hostnameFromSavedDomain("")).toBeNull();
    expect(hostnameFromSavedDomain("   ")).toBeNull();
  });

  test("returns null for a value that is not a URL", () => {
    // The column can hold anything if it was written by hand rather than
    // through the Settings form.
    expect(hostnameFromSavedDomain("not a url")).toBeNull();
    expect(hostnameFromSavedDomain("paco.example.com")).toBeNull();
  });

  test("returns null for a scheme with no host", () => {
    // `new URL("localhost:3066")` parses — as the scheme "localhost:" with the
    // path "3066" and an empty host. The same trap `lib/app-url.ts` documents,
    // so "did it throw" is not a sufficient check here either.
    expect(hostnameFromSavedDomain("localhost:3066")).toBeNull();
  });
});
