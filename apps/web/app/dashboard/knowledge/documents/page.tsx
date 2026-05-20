import Link from 'next/link';
import { getKnowledgeDocuments } from '@/lib/api/knowledge-server';

const docTypes = ['POLICY', 'SHIPPING_POLICY', 'RETURN_POLICY', 'PROMOTION', 'HOLIDAY_HOURS', 'SOP', 'CUSTOM'] as const;
const statuses = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export default async function KnowledgeDocumentsPage() {
  const docs = await getKnowledgeDocuments();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/dashboard/knowledge" className="text-sm text-muted-foreground hover:underline">
            ← Knowledge
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Policies, SOPs, promotions. Upload and reindex for vector search.
          </p>
        </div>
        <div className="rounded-md bg-muted px-3 py-1.5 text-sm text-muted-foreground">
          API-backed listing
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="text-sm text-muted-foreground">Type:</span>
        <span className="rounded-md bg-muted px-3 py-1.5 text-sm font-medium">All</span>
        {docTypes.map((t) => (
          <span
            key={t}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
          >
            {t.replace(/_/g, ' ')}
          </span>
        ))}
        <span className="ml-4 text-sm text-muted-foreground">Status:</span>
        {statuses.map((s) => (
          <span
            key={s}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground"
          >
            {s}
          </span>
        ))}
      </div>
      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-3 text-left font-medium">Title</th>
              <th className="p-3 text-left font-medium">Type</th>
              <th className="p-3 text-left font-medium">Status</th>
              <th className="p-3 text-left font-medium">Vector</th>
              <th className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
                <tr key={doc.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{doc.title}</td>
                  <td className="p-3 text-muted-foreground">{doc.type.replace(/_/g, ' ')}</td>
                  <td className="p-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      doc.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                      doc.status === 'ARCHIVED' ? 'bg-gray-100 text-gray-600' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {doc.status}
                    </span>
                  </td>
                  <td className="p-3">
                    {doc.vectorFileId || doc.vectorStoreId ? (
                      <span className="text-green-600">Indexed</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2 text-xs text-muted-foreground">
                    {doc.id.slice(0, 8)}...
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
