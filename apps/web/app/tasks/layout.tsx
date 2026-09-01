import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SettingsLink } from "@/components/settings-link";

type TasksLayoutProps = {
  children: ReactNode;
};

/**
 * Minimal chrome for `/tasks`, matching `/sessions`'s own bar
 * (`[sessionId]/chats/[chatId]/session-header.tsx`): a way back on the
 * left. The task board has no workspace switcher of its own — it is one
 * page, not a set of per-session views — so there is nothing else this bar
 * needs to carry.
 */
export default function TasksLayout({ children }: TasksLayoutProps) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-base-100 text-base-content">
      <header className="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-1.5">
        <Link className="btn btn-ghost btn-sm gap-1.5" href="/sessions">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Sessions
        </Link>
        <SettingsLink />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
