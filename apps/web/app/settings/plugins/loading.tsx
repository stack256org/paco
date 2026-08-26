function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-base-300 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-4 w-32 rounded bg-base-200" />
          <div className="h-3 w-48 rounded bg-base-200" />
        </div>
        <div className="h-5 w-9 rounded-full bg-base-200" />
      </div>
      <div className="flex gap-1.5">
        <div className="h-5 w-20 rounded-full bg-base-200" />
        <div className="h-5 w-24 rounded-full bg-base-200" />
      </div>
    </div>
  );
}

export default function PluginsPageLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-24 rounded bg-base-200" />
          <div className="h-4 w-80 max-w-full rounded bg-base-200" />
        </div>
        <div className="h-8 w-28 rounded-md bg-base-200" />
      </div>

      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
