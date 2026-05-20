/** Server-safe status blocks for dashboard pages that fetch from the API. */
export function DashboardError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border border-red-200/80 bg-red-50/50 px-6 py-8 dark:border-red-900/50 dark:bg-red-950/30">
      <p className="text-sm font-medium text-red-800 dark:text-red-300">{title}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-red-700/90 dark:text-red-200/90">{message}</p>
    </div>
  );
}

export function DashboardEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/10 px-8 py-14 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
