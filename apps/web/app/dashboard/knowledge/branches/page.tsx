import Link from 'next/link';
import { getKnowledgeBranches } from '@/lib/api/knowledge-server';

export default async function KnowledgeBranchesPage() {
  const branches = await getKnowledgeBranches();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/dashboard/knowledge" className="text-sm text-muted-foreground hover:underline">
            ← Knowledge
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Branch Profiles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses, hours, phone, pickup & delivery per branch for branch-specific answers.
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
              <th className="p-3 text-left font-medium">Name</th>
              <th className="p-3 text-left font-medium">City / Area</th>
              <th className="p-3 text-left font-medium">Phone</th>
              <th className="p-3 text-left font-medium">Status</th>
              <th className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
                <tr key={branch.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{branch.name}</td>
                  <td className="p-3 text-muted-foreground">{branch.city} / {branch.area}</td>
                  <td className="p-3">{branch.phone}</td>
                  <td className="p-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${branch.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                      {branch.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-3 text-right text-xs text-muted-foreground">
                    {branch.id.slice(0, 8)}...
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
