"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { BotMessageSquare, Phone, Plus, TrendingUp } from "lucide-react";
import { listAgents, listCalls } from "@/lib/api";
import { getStoredTenant } from "@/lib/auth";
import type { Agent, CallLog } from "@/lib/types";

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const tenant = getStoredTenant();

  useEffect(() => {
    Promise.all([listAgents(), listCalls(undefined, 20)])
      .then(([a, c]) => { setAgents(a); setCalls(c); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const activeAgents = agents.filter((a) => a.is_active).length;
  const todayCalls = calls.filter((c) => {
    const d = new Date(c.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;
  const completedCalls = calls.filter((c) => c.status === "completed").length;

  if (loading) {
    return <div className="text-gray-400 text-sm">Loading dashboard...</div>;
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back{tenant?.name ? `, ${tenant.name}` : ""}
        </h1>
        <p className="text-gray-500 mt-1">Here's what's happening with your voice agents.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard icon={<BotMessageSquare size={20} />} label="Active Agents" value={activeAgents} />
        <StatCard icon={<Phone size={20} />} label="Calls Today" value={todayCalls} />
        <StatCard icon={<TrendingUp size={20} />} label="Completed Calls" value={completedCalls} />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-3">Quick Actions</h2>
          <Link href="/dashboard/agents/new" className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} />
            Create New Agent
          </Link>
        </div>
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-1">API Key</h2>
          <p className="text-xs text-gray-400 mb-2">Use this to authenticate API requests</p>
          <code className="text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 block truncate">
            {tenant?.api_key || "—"}
          </code>
        </div>
      </div>

      {/* Recent agents */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Recent Agents</h2>
          <Link href="/dashboard/agents" className="text-sm text-brand-500 hover:underline">
            View all
          </Link>
        </div>
        {agents.length === 0 ? (
          <p className="text-sm text-gray-400">
            No agents yet.{" "}
            <Link href="/dashboard/agents/new" className="text-brand-500 hover:underline">
              Create your first agent.
            </Link>
          </p>
        ) : (
          <div className="space-y-2">
            {agents.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-900">{a.name}</p>
                  <p className="text-xs text-gray-400">{a.llm_model} · {a.voice_id}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${a.is_active ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                  {a.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="card flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-500 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-sm text-gray-400">{label}</p>
      </div>
    </div>
  );
}
