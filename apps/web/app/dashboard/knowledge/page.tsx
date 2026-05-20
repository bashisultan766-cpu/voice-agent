import Link from 'next/link';

export default function KnowledgePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge Base</h1>
        <p className="mt-1 text-muted-foreground">
          FAQs, branch profiles, policies, and documents for your voice agent.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/dashboard/knowledge/faqs"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">FAQs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage store and branch-specific Q&A for quick voice answers.
          </p>
        </Link>
        <Link
          href="/dashboard/knowledge/branches"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Branch Profiles</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses, hours, phone, pickup & delivery per branch.
          </p>
        </Link>
        <Link
          href="/dashboard/knowledge/documents"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Documents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Policies, SOPs, promotions. Upload for vector search.
          </p>
        </Link>
      </div>
    </div>
  );
}
