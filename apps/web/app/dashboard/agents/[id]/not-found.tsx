import Link from 'next/link';

export default function AgentNotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold text-foreground">Agent not found</h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        This agent may have been deleted or the link is incorrect.
      </p>
      <Link
        href="/dashboard/agents"
        className="mt-6 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Back to Agents
      </Link>
    </div>
  );
}
