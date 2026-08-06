import { describe, expect, test } from "bun:test";

import {
  isValidGitHubRepoName,
  isValidGitHubRepoOwner,
  parseGitHubHttpsUrl,
  parseGitHubUrl,
} from "./urls";

describe("repo-identifiers", () => {
  test("accepts safe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner("acme")).toBe(true);
    expect(isValidGitHubRepoOwner("acme-labs")).toBe(true);
    expect(isValidGitHubRepoName("paco")).toBe(true);
    expect(isValidGitHubRepoName("paco.v2")).toBe(true);
  });

  test("rejects unsafe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner('acme" && echo nope && "')).toBe(false);
    expect(isValidGitHubRepoName("my repo")).toBe(false);
  });

  test("parses only real github.com HTTPS repo URLs", () => {
    expect(parseGitHubHttpsUrl("https://github.com/acme/paco.git")).toEqual({
      owner: "acme",
      repo: "paco",
    });
    expect(
      parseGitHubHttpsUrl("https://attacker.example/github.com/acme/repo"),
    ).toBeNull();
    expect(parseGitHubHttpsUrl("http://github.com/acme/repo")).toBeNull();
    expect(
      parseGitHubHttpsUrl("https://github.com/acme/repo/extra"),
    ).toBeNull();
  });

  test("parses SSH GitHub URLs without accepting arbitrary hosts", () => {
    expect(parseGitHubUrl("git@github.com:acme/paco.git")).toEqual({
      owner: "acme",
      repo: "paco",
    });
    expect(
      parseGitHubUrl("git@attacker.example:github.com/acme/repo.git"),
    ).toBeNull();
  });
});
