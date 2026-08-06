"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, FolderGit2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGithubConnection } from "@/hooks/use-github-connection";
import { useGithubOwners } from "@/hooks/use-github-owners";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { Session } from "@/lib/db/schema";
import { buildGitHubReconnectUrl } from "@/lib/github/urls";

interface CreateRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  hasSandbox: boolean;
  onRepoCreated?: (result: {
    repoUrl: string;
    owner: string;
    repoName: string;
    cloneUrl: string;
    branch: string;
  }) => void;
}

interface CreateRepoResult {
  repoUrl: string;
  owner: string;
  repoName: string;
}

function getCurrentPathWithSearch(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-")
    .trim()
    .slice(0, 50);
}

export function CreateRepoDialog({
  open,
  onOpenChange,
  session,
  hasSandbox,
  onRepoCreated,
}: CreateRepoDialogProps) {
  const [repoName, setRepoName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [result, setResult] = useState<CreateRepoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<string>("");
  const { connected: githubConnected } = useGithubConnection({ enabled: open });
  const { owners, loading: loadingOwners } = useGithubOwners({
    enabled: open && githubConnected,
  });
  const reconnectRequired = !githubConnected;

  const handleReconnect = () => {
    window.location.href = buildGitHubReconnectUrl(getCurrentPathWithSearch());
  };

  // Reset form state when dialog opens
  useEffect(() => {
    if (open) {
      const suggestedName = slugify(session.title);
      setRepoName(suggestedName);
      setDescription("");
      setIsPrivate(false);
      setResult(null);
      setError(null);
    }
  }, [open, session.title]);

  // Default to the user's own account, which is the first entry.
  useEffect(() => {
    if (open && owners.length > 0 && !selectedOwner && owners[0]) {
      setSelectedOwner(owners[0]);
    }
  }, [open, owners, selectedOwner]);

  const handleCreate = async () => {
    if (!repoName.trim()) {
      setError("Repository name is required");
      return;
    }

    if (!hasSandbox) {
      setError("This session is still starting up. Try again in a moment.");
      return;
    }

    if (reconnectRequired) {
      setError("Reconnect GitHub before creating a repository.");
      return;
    }

    if (!selectedOwner) {
      // There is no GitHub App any more, so "install it first" was advice for a
      // thing that does not exist; owners come from the connected token.
      setError("Choose which GitHub account this repository belongs to.");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/github/create-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          repoName: repoName.trim(),
          description: description.trim() || undefined,
          isPrivate,
          sessionTitle: session.title,
          owner: selectedOwner,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to create repository");
      }

      const createResult = {
        repoUrl: data.repoUrl as string,
        owner: data.owner as string,
        repoName: data.repoName as string,
        cloneUrl: data.cloneUrl as string,
        branch: data.branch as string,
      };
      setResult(createResult);
      onRepoCreated?.(createResult);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create repository",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="h-5 w-5" />
            Create Repository
          </DialogTitle>
          <DialogDescription>
            Put the work from this session into a new GitHub repository, so it
            is saved somewhere other than this machine.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          // Success state
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
              <Check className="h-6 w-6 text-success" />
            </div>
            <div className="text-center">
              <p className="font-medium">Repository created successfully!</p>
              <p className="mt-1 text-sm text-base-content/60">
                {result.owner}/{result.repoName}
              </p>
              {/* External link to GitHub - not internal navigation */}
              {/* oxlint-disable-next-line nextjs/no-html-link-for-pages */}
              <a
                href={result.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-info hover:underline"
              >
                View on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
          </div>
        ) : (
          // Form
          <>
            <div className="grid gap-4 py-4">
              {/* Owner / Account Picker */}
              <div className="grid gap-2">
                <Label htmlFor="repo-owner">Owner</Label>
                {reconnectRequired ? (
                  <div className="space-y-3 rounded-md border border-warning/30 bg-warning/10 p-3">
                    <p className="text-sm text-base-content/60">
                      Your saved GitHub connection is no longer valid. Reconnect
                      before creating a repository.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleReconnect}
                    >
                      Reconnect GitHub
                    </Button>
                  </div>
                ) : loadingOwners ? (
                  <div className="flex items-center gap-2 text-sm text-base-content/60">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading accounts...
                  </div>
                ) : owners.length > 0 ? (
                  <Select
                    value={selectedOwner}
                    onValueChange={setSelectedOwner}
                    disabled={isCreating}
                  >
                    <SelectTrigger id="repo-owner" className="w-full">
                      <SelectValue placeholder="Select an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {owners.map((owner) => (
                        <SelectItem key={owner} value={owner}>
                          {owner}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-base-content/60">
                    No GitHub accounts came back for your connection. Check that
                    it is still valid in Settings, then try again.
                  </p>
                )}
              </div>

              {/* Repository Name */}
              <div className="grid gap-2">
                <Label htmlFor="repo-name">Repository name</Label>
                {selectedOwner && (
                  <p className="text-xs text-base-content/60">
                    {selectedOwner}/{repoName || "..."}
                  </p>
                )}
                <Input
                  id="repo-name"
                  placeholder="my-awesome-project"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  disabled={isCreating}
                />
                <p className="text-xs text-base-content/60">
                  Use letters, numbers, hyphens, underscores, and periods only.
                </p>
              </div>

              {/* Description */}
              <div className="grid gap-2">
                <Label htmlFor="repo-description">Description (optional)</Label>
                <Textarea
                  id="repo-description"
                  placeholder="A short description of your project"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={isCreating}
                  rows={3}
                  className="resize-none"
                />
              </div>

              {/* Private Toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="repo-private">Private repository</Label>
                  <p className="text-xs text-base-content/60">
                    Only you can see this repository
                  </p>
                </div>
                <Switch
                  id="repo-private"
                  checked={isPrivate}
                  onCheckedChange={setIsPrivate}
                  disabled={isCreating}
                />
              </div>

              {/* Error Alert */}
              {error && (
                <div className="rounded-md bg-error/10 p-3 text-sm text-error">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={
                  isCreating ||
                  reconnectRequired ||
                  !repoName.trim() ||
                  !hasSandbox ||
                  !selectedOwner
                }
              >
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Repository"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
