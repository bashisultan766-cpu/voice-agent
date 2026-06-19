"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import AgentForm from "@/components/agents/AgentForm";
import { createAgent } from "@/lib/api";
import type { AgentCreate } from "@/lib/types";

export default function NewAgentPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(data: AgentCreate) {
    setLoading(true);
    setError("");
    try {
      const agent = await createAgent(data);
      router.push(`/dashboard/agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/agents" className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Create Agent</h1>
          <p className="text-gray-500 text-sm mt-0.5">Configure a new AI voice agent</p>
        </div>
      </div>
      <AgentForm onSubmit={handleSubmit} loading={loading} error={error} />
    </div>
  );
}
