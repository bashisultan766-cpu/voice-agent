"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle, XCircle } from "lucide-react";
import AgentForm from "@/components/agents/AgentForm";
import { getAgent, updateAgent, testShopifyConnection } from "@/lib/api";
import type { Agent, AgentUpdate } from "@/lib/types";

export default function EditAgentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loadingAgent, setLoadingAgent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getAgent(id)
      .then(setAgent)
      .catch(() => router.push("/dashboard/agents"))
      .finally(() => setLoadingAgent(false));
  }, [id, router]);

  async function handleSubmit(data: AgentUpdate) {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateAgent(id, data);
      setAgent(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestShopify() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testShopifyConnection(id);
      setTestResult({
        success: result.success,
        message: result.success
          ? `Connected! Found ${result.products_found} product(s).`
          : result.error || "Connection failed",
      });
    } catch {
      setTestResult({ success: false, message: "Test request failed" });
    } finally {
      setTesting(false);
    }
  }

  if (loadingAgent) return <div className="text-gray-400 text-sm">Loading agent...</div>;
  if (!agent) return null;

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/agents" className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">{agent.name}</h1>
            {saved && (
              <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                <CheckCircle size={13} /> Saved
              </span>
            )}
          </div>
          <p className="text-gray-500 text-sm mt-0.5">Edit agent configuration</p>
        </div>
      </div>

      {/* Shopify test button */}
      <div className="card mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Test Shopify Connection</p>
            <p className="text-xs text-gray-400">Verify your Shopify credentials are working</p>
          </div>
          <button onClick={handleTestShopify} disabled={testing} className="btn-secondary text-sm">
            {testing ? "Testing..." : "Test Connection"}
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm ${testResult.success ? "text-green-600" : "text-red-500"}`}>
            {testResult.success ? <CheckCircle size={15} /> : <XCircle size={15} />}
            {testResult.message}
          </div>
        )}
      </div>

      <AgentForm initial={agent} onSubmit={handleSubmit} loading={saving} error={error} />

      <div className="mt-4">
        <Link href={`/dashboard/agents/${id}/logs`} className="text-sm text-brand-500 hover:underline">
          View call logs for this agent
        </Link>
      </div>
    </div>
  );
}
