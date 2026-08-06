import { describe, expect, test } from "bun:test";
import {
  ALREADY_EXISTS,
  ARCHIVED_REPO,
  AUTH_EXPIRED,
  GENERIC,
  ghFailureMessage,
  NETWORK,
  NO_WRITE_ACCESS,
  NOT_FOUND,
  NOTHING_TO_PUBLISH,
  PULL_REQUEST_EXISTS,
  RATE_LIMITED,
  REJECTED_PUSH,
  REPO_NAME_TAKEN,
  SSO_REQUIRED,
} from "@/lib/github/gh-failure-copy";

type Case = {
  name: string;
  command: "gh" | "git";
  /** Verbatim `gh`/`git` output, copied from a real failure. */
  stderr: string;
  expected: string;
};

const CASES: Case[] = [
  // --- Rate limits. Never the write-access copy: the token is fine. ---
  {
    name: "primary rate limit on a REST call",
    command: "gh",
    stderr:
      "gh: API rate limit exceeded for user ID 1234. (HTTP 403)\nIf you reach out to GitHub Support for help, please include the request ID ABCD:1234.\n",
    expected: RATE_LIMITED,
  },
  {
    name: "secondary rate limit while creating content",
    command: "gh",
    stderr:
      "gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later. (HTTP 403)\n",
    expected: RATE_LIMITED,
  },
  {
    name: "abuse detection mechanism",
    command: "gh",
    stderr:
      "gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)\n",
    expected: RATE_LIMITED,
  },
  {
    name: "rate limit reported as HTTP 429",
    command: "gh",
    stderr: "gh: Too Many Requests (HTTP 429)\n",
    expected: RATE_LIMITED,
  },

  // --- Archived repository. ---
  {
    name: "archived repository over the API",
    command: "gh",
    stderr: "gh: This repository was archived so it is read-only. (HTTP 403)\n",
    expected: ARCHIVED_REPO,
  },
  {
    name: "archived repository on push",
    command: "git",
    stderr:
      "remote: ERROR: This repository was archived so it is read-only.\nfatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403\n",
    expected: ARCHIVED_REPO,
  },

  // --- Single sign-on. ---
  {
    name: "SAML enforcement over GraphQL",
    command: "gh",
    stderr:
      "pull request create failed: GraphQL: Resource protected by organization SAML enforcement. You must grant your Personal Access Token access to this organization. (createPullRequest)\n",
    expected: SSO_REQUIRED,
  },
  {
    name: "SAML SSO on push",
    command: "git",
    stderr:
      "remote: The `acme' organization has enabled or enforced SAML SSO. To access this repository, you must use a personal access token and authorize it for this organization.\nfatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403\n",
    expected: SSO_REQUIRED,
  },

  // --- Genuinely missing write access, including git's own 403 wording. ---
  {
    name: "push denied by name",
    command: "git",
    stderr:
      "remote: Permission to acme/widgets.git denied to octocat.\nfatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403\n",
    expected: NO_WRITE_ACCESS,
  },
  {
    name: "git transport 403 with no other wording",
    command: "git",
    stderr:
      "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403\n",
    expected: NO_WRITE_ACCESS,
  },
  {
    name: "gh reports HTTP 403",
    command: "gh",
    stderr: "gh: Must have admin rights to Repository. (HTTP 403)\n",
    expected: NO_WRITE_ACCESS,
  },

  // --- Nothing to publish. ---
  {
    name: "no commits between the branches",
    command: "gh",
    stderr:
      "pull request create failed: GraphQL: No commits between main and chat/9f2c1a (createPullRequest)\n",
    expected: NOTHING_TO_PUBLISH,
  },

  // --- Things that already exist. ---
  {
    name: "repository name taken on the account",
    command: "gh",
    stderr: "GraphQL: Name already exists on this account (createRepository)\n",
    expected: REPO_NAME_TAKEN,
  },
  {
    name: "pull request already open for the branch",
    command: "gh",
    stderr:
      "pull request create failed: GraphQL: A pull request already exists for acme:chat/9f2c1a. (createPullRequest)\n",
    expected: PULL_REQUEST_EXISTS,
  },
  {
    name: "gh names the existing pull request",
    command: "gh",
    stderr:
      'a pull request for branch "chat/9f2c1a" into branch "main" already exists:\nhttps://github.com/acme/widgets/pull/12\n',
    expected: PULL_REQUEST_EXISTS,
  },
  {
    name: "branch reference already exists",
    command: "gh",
    stderr: "gh: Reference already exists (HTTP 422)\n",
    expected: ALREADY_EXISTS,
  },

  // --- Unchanged mappings, kept honest while the order moves around. ---
  {
    name: "no network",
    command: "gh",
    stderr:
      'gh: Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\ncould not resolve host: api.github.com\n',
    expected: NETWORK,
  },
  {
    name: "token rejected",
    command: "gh",
    stderr:
      "gh: Bad credentials (HTTP 401)\nTry authenticating with: gh auth login\n",
    expected: AUTH_EXPIRED,
  },
  {
    name: "push rejected as non-fast-forward",
    command: "git",
    stderr:
      "To https://github.com/acme/widgets.git\n ! [rejected]        chat/9f2c1a -> chat/9f2c1a (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/acme/widgets.git'\nhint: Updates were rejected because the tip of your current branch is behind\n",
    expected: REJECTED_PUSH,
  },
  {
    name: "repository not visible to this account",
    command: "gh",
    stderr:
      "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)\n",
    expected: NOT_FOUND,
  },
  {
    name: "unrecognised failure",
    command: "gh",
    stderr: "gh: something nobody has mapped yet\n",
    expected: GENERIC,
  },
];

describe("ghFailureMessage", () => {
  for (const testCase of CASES) {
    test(testCase.name, () => {
      expect(
        ghFailureMessage({
          command: testCase.command,
          stderr: testCase.stderr,
          exitCode: 1,
        }),
      ).toBe(testCase.expected);
    });
  }
});

/**
 * The matchers are ordered and the first one wins, so these assert the
 * mis-mapping each ordering rule exists to prevent — a passing table above
 * would not notice a matcher moving one line up.
 */
describe("matcher ordering", () => {
  const message = (stderr: string) =>
    ghFailureMessage({ command: "gh", stderr, exitCode: 1 });

  test("a rate limit never tells the user their access is wrong", () => {
    for (const stderr of [
      "gh: API rate limit exceeded for user ID 1234. (HTTP 403)",
      "gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later. (HTTP 403)",
    ]) {
      expect(message(stderr)).not.toBe(NO_WRITE_ACCESS);
      expect(message(stderr)).not.toBe(AUTH_EXPIRED);
      expect(message(stderr)).toBe(RATE_LIMITED);
    }
  });

  test("an archived repository is explained, not left generic", () => {
    const stderr =
      "gh: This repository was archived so it is read-only. (HTTP 403)";
    expect(message(stderr)).not.toBe(GENERIC);
    expect(message(stderr)).not.toBe(NO_WRITE_ACCESS);
    expect(message(stderr)).toBe(ARCHIVED_REPO);
  });

  test("single sign-on is explained, not read as missing permissions", () => {
    const stderr =
      "GraphQL: Resource protected by organization SAML enforcement. You must grant your Personal Access Token access to this organization.";
    expect(message(stderr)).not.toBe(GENERIC);
    expect(message(stderr)).not.toBe(NO_WRITE_ACCESS);
    expect(message(stderr)).toBe(SSO_REQUIRED);
  });

  test("git's own 403 wording maps to something specific", () => {
    const stderr =
      "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403";
    expect(message(stderr)).not.toBe(GENERIC);
    expect(message(stderr)).toBe(NO_WRITE_ACCESS);
  });

  test("a taken repository name is not answered with 'refresh the page'", () => {
    const stderr =
      "GraphQL: Name already exists on this account (createRepository)";
    expect(message(stderr)).not.toBe(ALREADY_EXISTS);
    expect(message(stderr)).toBe(REPO_NAME_TAKEN);
  });

  test("an existing pull request points at the open one", () => {
    const stderr =
      "pull request create failed: GraphQL: A pull request already exists for acme:chat/9f2c1a.";
    expect(message(stderr)).not.toBe(ALREADY_EXISTS);
    expect(message(stderr)).toBe(PULL_REQUEST_EXISTS);
  });

  test("an empty branch is not reported as a GitHub outage", () => {
    const stderr =
      "pull request create failed: GraphQL: No commits between main and chat/9f2c1a (createPullRequest)";
    expect(message(stderr)).not.toBe(GENERIC);
    expect(message(stderr)).toBe(NOTHING_TO_PUBLISH);
  });

  test("a repository whose name contains 'saml' is still a not-found", () => {
    expect(
      message(
        "GraphQL: Could not resolve to a Repository with the name 'acme/saml-service'.",
      ),
    ).toBe(NOT_FOUND);
  });
});

describe("user-facing copy", () => {
  const ALL_MESSAGES = [
    ALREADY_EXISTS,
    ARCHIVED_REPO,
    AUTH_EXPIRED,
    GENERIC,
    NETWORK,
    NOT_FOUND,
    NO_WRITE_ACCESS,
    NOTHING_TO_PUBLISH,
    PULL_REQUEST_EXISTS,
    RATE_LIMITED,
    REJECTED_PUSH,
    REPO_NAME_TAKEN,
    SSO_REQUIRED,
  ];

  test("no message leaks a status code or a command", () => {
    for (const copy of ALL_MESSAGES) {
      expect(copy).not.toMatch(/\b(403|401|404|422|429)\b/);
      expect(copy).not.toMatch(/http|graphql|stderr|\bgit push\b|\bgh \b/i);
    }
  });
});
