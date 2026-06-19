"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, BotMessageSquare, Pencil, Trash2, Phone } from "lucide-react";
import { listAgents, deleteAgent } from "@/lib/api";
import type { Agent } from "@/lib/types";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    try {
      const data = await listAgents();
      setAgents(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await deleteAgent(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      alert("Failed to delete agent");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="text-gray-500 mt-0.5 text-sm">Manage your AI voice agents</p>
        </div>
        <Link href="/dashboard/agents/new" className="btn-primary inline-flex items-center gap-2">
          <Plus size={16} />
          New Agent
        </Link>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Loading agents...</div>
      ) : agents.length === 0 ? (
        <div className="card text-center py-12">
          <BotMessageSquare size={36} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 mb-4">No agents yet. Create your first one.</p>
          <Link href="/dashboard/agents/new" className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} /> Create Agent
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <div key={agent.id} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-500 flex items-center justify-center flex-shrink-0">
                  <BotMessageSquare size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-900">{agent.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${agent.is_active ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                      {agent.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {agent.llm_model} · Voice: {agent.voice_id}
                    {agent.twilio_phone_number && ` · ${agent.twilio_phone_number}`}
                  </p>
                  {agent.shopify_store_url && (
                    <p className="text-xs text-gray-400">{agent.shopify_store_url}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/dashboard/agents/${agent.id}/logs`}
                  className="btn-secondary inline-flex items-center gap-1.5 text-xs"
                >
                  <Phone size={13} /> Logs
                </Link>
                <Link
                  href={`/dashboard/agents/${agent.id}`}
                  className="btn-secondary inline-flex items-center gap-1.5 text-xs"
                >
                  <Pencil size={13} /> Edit
                </Link>
                <button
                  onClick={() => handleDelete(agent.id, agent.name)}
                  disabled={deleting === agent.id}
                  className="btn-danger inline-flex items-center gap-1.5 text-xs"
                >
                  <Trash2 size={13} />
                  {deleting === agent.id ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
