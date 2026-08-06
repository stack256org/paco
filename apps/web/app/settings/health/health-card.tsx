import type { LucideIcon } from "lucide-react";

/** The shared card chrome every section on this page uses. */
export function HealthCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card border border-base-content/10 bg-base-100">
      <div className="card-body gap-4">
        <h2 className="card-title text-base">
          <Icon aria-hidden="true" className="size-4" />
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** A card's skeleton while its data has not loaded yet. */
export function HealthCardSkeleton() {
  return (
    <div className="card border border-base-content/10 bg-base-100">
      <div className="card-body gap-3">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-16 w-full" />
      </div>
    </div>
  );
}
