function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 border-base-300 border-t px-4 py-3 first:border-t-0">
      <div className="h-4 w-32 rounded bg-base-200" />
      <div className="h-4 w-16 rounded bg-base-200" />
      <div className="h-4 w-14 rounded bg-base-200" />
      <div className="ml-auto h-5 w-9 rounded-full bg-base-200" />
    </div>
  );
}

export default function AgentsPageLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-24 rounded bg-base-200" />
          <div className="h-4 w-80 max-w-full rounded bg-base-200" />
        </div>
        <div className="h-8 w-28 rounded-md bg-base-200" />
      </div>

      <div className="overflow-hidden rounded-lg border border-base-300">
        {[1, 2, 3, 4].map((i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
