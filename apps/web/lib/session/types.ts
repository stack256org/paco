export interface Session {
  created: number;
  user: {
    id: string;
    username: string;
    email: string | undefined;
    name?: string;
  };
}

export interface SessionUserInfo {
  user: Session["user"] | undefined;
  isAdmin?: boolean;
  /** Whether a GitHub token is stored for this user. */
  hasGitHub?: boolean;
  /** The connected GitHub login, for display. */
  githubLogin?: string | null;
}
