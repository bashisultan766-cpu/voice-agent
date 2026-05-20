import Link from 'next/link';
import { getKnowledgeFaqs } from '@/lib/api/knowledge-server';

export default async function KnowledgeFaqsPage() {
  const faqs = await getKnowledgeFaqs();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/dashboard/knowledge" className="text-sm text-muted-foreground hover:underline">
            ← Knowledge
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">FAQs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Short Q&A used by the voice agent for fast answers.
          </p>
        </div>
        <div className="rounded-md bg-muted px-3 py-1.5 text-sm text-muted-foreground">
          API-backed listing
        </div>
      </div>
      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-3 text-left font-medium">Question</th>
              <th className="p-3 text-left font-medium">Answer (preview)</th>
              <th className="p-3 text-left font-medium">Status</th>
              <th className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {faqs.map((faq) => (
                <tr key={faq.id} className="border-b last:border-0">
                  <td className="p-3">{faq.question}</td>
                  <td className="max-w-xs truncate p-3 text-muted-foreground">{faq.answer}</td>
                  <td className="p-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${faq.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                      {faq.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-3 text-right text-xs text-muted-foreground">
                    {faq.id.slice(0, 8)}...
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
