import Link from 'next/link';
import { DeleteAgentButton } from './DeleteAgentButton';

export interface Agent {
  id: string;
  name: string;
  status: 'active' | 'draft' | 'paused';
  storeName?: string;
  updatedAt: string;
}

interface AgentsTableProps {
  agents: Agent[];
}

const statusStyles: Record<Agent['status'], string> = {
  active: 'bg-green-100 text-green-800',
  draft: 'bg-amber-100 text-amber-800',
  paused: 'bg-gray-100 text-gray-600',
};

export function AgentsTable({ agents }: AgentsTableProps) {
  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="p-3 text-left font-medium">Name</th>
            <th className="p-3 text-left font-medium">Status</th>
            <th className="p-3 text-left font-medium">Store</th>
            <th className="p-3 text-left font-medium">Updated</th>
            <th className="p-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id} className="border-b last:border-0 hover:bg-muted/30">
              <td className="p-3 font-medium">{agent.name}</td>
              <td className="p-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusStyles[agent.status]}`}
                >
                  {agent.status}
                </span>
              </td>
              <td className="p-3 text-muted-foreground">{agent.storeName ?? '—'}</td>
              <td className="p-3 text-muted-foreground">{agent.updatedAt}</td>
              <td className="p-3 text-right">
                <span className="inline-flex items-center gap-3">
                  <Link
                    href={`/dashboard/agents/${agent.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    Edit
                  </Link>
                  <DeleteAgentButton agentId={agent.id} agentName={agent.name} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
