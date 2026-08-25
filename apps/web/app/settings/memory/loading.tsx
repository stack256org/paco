function CardSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border border-base-300 p-4">
      <div className="h-4 w-48 rounded bg-base-200" />
      <div className="h-3 w-24 rounded bg-base-200" />
      <div className="mt-2 h-3 w-full rounded bg-base-200" />
      <div className="h-3 w-3/4 rounded bg-base-200" />
    </div>
  );
}

export default function MemoryPageLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="h-7 w-28 rounded bg-base-200" />
        <div className="h-4 w-96 max-w-full rounded bg-base-200" />
        <div className="h-4 w-80 max-w-full rounded bg-base-200" />
      </div>

      <div className="space-y-3">
        <div className="h-5 w-32 rounded bg-base-200" />
        {[1, 2].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
