export default function AgentEditLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="h-4 w-20 animate-pulse rounded bg-muted" />
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="flex gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 w-16 flex-1 animate-pulse rounded-full bg-muted" />
        ))}
      </div>
      <div className="space-y-6">
        <div className="h-64 animate-pulse rounded-lg border border-border bg-card" />
        <div className="flex justify-between gap-4 border-t pt-6">
          <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-20 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    </div>
  );
}
