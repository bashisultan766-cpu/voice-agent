'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

export default function StoreKnowledgePage() {
  const params = useParams();
  const storeId = params?.id as string;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/dashboard/stores/${storeId}`} className="text-sm text-muted-foreground hover:underline">
          ← Store
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Store Knowledge Center</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          FAQs, branches, and documents for this store. Used by the voice agent when this store is in context.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/dashboard/knowledge/faqs"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">FAQs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage FAQs for this store.</p>
        </Link>
        <Link
          href="/dashboard/knowledge/branches"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Branches</h2>
          <p className="mt-1 text-sm text-muted-foreground">Branch profiles for this store.</p>
        </Link>
        <Link
          href="/dashboard/knowledge/documents"
          className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
        >
          <h2 className="font-medium">Documents</h2>
          <p className="mt-1 text-sm text-muted-foreground">Policies and docs for this store.</p>
        </Link>
      </div>
    </div>
  );
}
