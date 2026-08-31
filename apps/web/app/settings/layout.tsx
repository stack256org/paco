"use client";

import {
  Activity,
  ChartLine,
  ArrowLeft,
  Bot,
  Brain,
  Cable,
  Clock,
  Menu,
  Puzzle,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  User,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "@/hooks/use-session";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const baseSidebarItems = [
  {
    id: "profile",
    label: "Profile",
    href: "/settings/profile",
    icon: User,
  },
  {
    id: "preferences",
    label: "Preferences",
    href: "/settings/preferences",
    icon: SettingsIcon,
  },
  {
    id: "connections",
    label: "Connections",
    href: "/settings/connections",
    icon: Cable,
  },
  {
    id: "models",
    label: "Models",
    href: "/settings/models",
    icon: SlidersHorizontal,
  },
  {
    /*
     * Previously unreachable: the page existed but nothing linked to it, so the
     * only way in was typing the URL. It reports this account's own token spend,
     * which is worth surfacing now that the cross-user leaderboard is gone.
     */
    id: "usage",
    label: "Usage",
    href: "/settings/usage",
    icon: ChartLine,
  },
  {
    /*
     * Sits with the base items, not the admin-only ones below: every user
     * has their own memory to read, edit, and delete here, even though the
     * page's second section (organisation memory) is admin only.
     */
    id: "memory",
    label: "Memory",
    href: "/settings/memory",
    icon: Brain,
  },
  {
    /*
     * Member-viewable like Memory: every member sees the organisation's
     * cron schedules, even though creating, editing, and firing one is
     * admin only (enforced in `./schedules/actions.ts`, not here).
     */
    id: "schedules",
    label: "Schedules",
    href: "/settings/schedules",
    icon: Clock,
  },
];

/*
 * Admin-only entries.
 */
const adminSidebarItems = [
  {
    id: "agents",
    label: "Agents",
    href: "/settings/agents",
    icon: Bot,
  },
  {
    id: "health",
    label: "Health",
    href: "/settings/health",
    icon: Activity,
  },
  {
    /*
     * Admin-only, like Agents and Health above: installing a plugin and
     * granting it capabilities is an administrative act (`./plugins/actions.ts`
     * enforces this itself, regardless of what this nav shows).
     */
    id: "plugins",
    label: "Plugins",
    href: "/settings/plugins",
    icon: Puzzle,
  },
  {
    id: "admin",
    label: "Admin",
    href: "/settings/admin",
    icon: ShieldAlert,
  },
];

function SettingsLayout({
  children,
  pathname,
  isAdmin,
}: {
  children: React.ReactNode;
  pathname: string;
  isAdmin: boolean;
}) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarItems = isAdmin
    ? [...baseSidebarItems, ...adminSidebarItems]
    : baseSidebarItems;
  const activeItem = sidebarItems.find((item) => item.href === pathname);

  const navItems = (
    <ul className="space-y-1">
      {sidebarItems.map((item) => {
        const isActive = pathname === item.href;
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              onClick={() => setMobileSidebarOpen(false)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-4 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-base-200 text-base-content"
                  : "text-base-content/60 hover:bg-base-200 hover:text-base-content",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-screen bg-base-100 text-base-content">
      <aside className="hidden w-64 shrink-0 border-r border-base-300 md:flex">
        <div className="flex h-full w-full flex-col overflow-y-auto">
          <div className="flex items-center gap-4 px-6 py-4">
            <Link
              href="/sessions"
              className="flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </div>
          <nav className="flex-1 px-2 py-2">
            <div className="mb-2 px-4 text-xs font-medium uppercase tracking-wider text-base-content/60">
              Settings
            </div>
            {navItems}
          </nav>
        </div>
      </aside>

      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="flex w-64 flex-col p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Settings navigation</SheetTitle>
          </SheetHeader>
          <div className="flex items-center gap-4 px-6 py-4">
            <Link
              href="/sessions"
              onClick={() => setMobileSidebarOpen(false)}
              className="flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </div>
          <nav className="flex-1 px-2 py-2">
            <div className="mb-2 px-4 text-xs font-medium uppercase tracking-wider text-base-content/60">
              Settings
            </div>
            {navItems}
          </nav>
        </SheetContent>
      </Sheet>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-base-300 px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open settings menu"
            onClick={() => setMobileSidebarOpen(true)}
            className="text-base-content/60 hover:text-base-content"
          >
            {/* The icon is the whole button, so the name has to be spelled
                out — otherwise this reads as an unlabelled button. */}
            <Menu aria-hidden="true" className="h-4 w-4" />
          </button>
          <span className="flex-1 truncate text-sm font-medium">
            {activeItem?.label ?? "Settings"}
          </span>
        </div>
        <div className="mx-auto max-w-5xl space-y-6 px-3 py-8 md:px-4 md:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAdmin } = useSession();

  return (
    <SettingsLayout pathname={pathname} isAdmin={isAdmin}>
      {children}
    </SettingsLayout>
  );
}
