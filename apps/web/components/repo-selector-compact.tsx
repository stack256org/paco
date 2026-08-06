"use client";

import { Check, Loader2, Lock, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { GithubIcon } from "@/components/github-icon";
import { Input } from "@/components/ui/input";
import { useGithubConnection } from "@/hooks/use-github-connection";
import { useGithubRepos } from "@/hooks/use-github-repos";

type RepoSelectorCompactProps = {
  selectedOwner: string;
  selectedRepo: string;
  onSelect: (owner: string, repo: string) => void;
};

/**
 * Pick a repository to start a session from.
 *
 * This used to be 545 lines, most of it about *installations*: which accounts
 * the GitHub App was installed on, an owner switcher to move between them,
 * repositories fetched per installation, and empty states explaining that the
 * App had to be installed somewhere before anything could be listed.
 *
 * None of that exists with a token — it can see every repository the person
 * can — so the control is what it always should have been: a search box over a
 * list.
 */
export function RepoSelectorCompact({
  selectedOwner,
  selectedRepo,
  onSelect,
}: RepoSelectorCompactProps) {
  const { connected, loading: connectionLoading } = useGithubConnection();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounced so typing does not fire a `gh` process per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { repos, loading } = useGithubRepos({
    enabled: connected,
    ...(debounced ? { query: debounced } : {}),
  });

  if (connectionLoading) {
    return <RepoSelectorSkeleton />;
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-base-300 px-4 py-6 text-center">
        <GithubIcon className="size-8 text-base-content/60" />
        <div className="space-y-1">
          <p className="font-medium text-sm">GitHub is not connected</p>
          <p className="text-base-content/60 text-xs">
            Connect an account to start a session from one of your repositories.
          </p>
        </div>
        <Link className="btn btn-sm" href="/settings/connections">
          Connect GitHub
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-base-content/40"
        />
        <Input
          aria-label="Search repositories"
          className="pl-8"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search repositories…"
          value={search}
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border border-base-300">
        {loading && repos.length === 0 ? (
          <RepoSelectorSkeleton />
        ) : repos.length === 0 ? (
          <p className="px-3 py-6 text-center text-base-content/60 text-sm">
            {debounced
              ? `No repositories matching “${debounced}”`
              : "No repositories found for this account."}
          </p>
        ) : (
          <ul>
            {repos.map((repo) => {
              const isSelected =
                repo.owner === selectedOwner && repo.name === selectedRepo;

              return (
                <li key={repo.nameWithOwner}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200"
                    onClick={() => onSelect(repo.owner, repo.name)}
                    type="button"
                  >
                    {isSelected ? (
                      <Check
                        aria-hidden="true"
                        className="size-4 shrink-0 text-primary"
                      />
                    ) : (
                      <span aria-hidden="true" className="size-4 shrink-0" />
                    )}
                    <span className="truncate">{repo.nameWithOwner}</span>
                    {repo.isPrivate ? (
                      <Lock
                        aria-label="Private"
                        className="ml-auto size-3.5 shrink-0 text-base-content/40"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function RepoSelectorSkeleton() {
  return (
    <div className="flex items-center justify-center gap-2 px-3 py-6 text-base-content/60 text-sm">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      Loading repositories…
    </div>
  );
}
