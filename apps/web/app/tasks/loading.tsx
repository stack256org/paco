function ColumnSkeleton() {
  return (
    <div className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-base-200/40 p-2">
      <div className="h-3 w-16 rounded bg-base-200" />
      <div className="h-20 animate-pulse rounded-lg bg-base-200" />
      <div className="h-20 animate-pulse rounded-lg bg-base-200" />
    </div>
  );
}

export default function TasksPageLoading() {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-24 rounded bg-base-200" />
          <div className="h-4 w-80 max-w-full rounded bg-base-200" />
        </div>
        <div className="h-8 w-28 rounded-md bg-base-200" />
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <ColumnSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
