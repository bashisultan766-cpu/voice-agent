"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Phone, Clock } from "lucide-react";
import { listCalls, getAgent } from "@/lib/api";
import type { Agent, CallLog, ConversationTurn } from "@/lib/types";

function statusColor(status: string) {
  switch (status) {
    case "completed": return "bg-green-50 text-green-600";
    case "in_progress": return "bg-blue-50 text-blue-600";
    case "failed": return "bg-red-50 text-red-500";
    default: return "bg-gray-100 text-gray-500";
  }
}

function TurnRow({ turn }: { turn: ConversationTurn }) {
  return (
    <div className={`flex gap-3 text-sm ${turn.role === "user" ? "text-gray-700" : "text-brand-700"}`}>
      <span className="font-semibold capitalize w-20 flex-shrink-0">{turn.role}</span>
      <span className="flex-1">{turn.content}</span>
      {turn.latency_ms && <span className="text-xs text-gray-300 flex-shrink-0">{turn.latency_ms}ms</span>}
    </div>
  );
}

function CallRow({ call }: { call: CallLog }) {
  const [expanded, setExpanded] = useState(false);
  const duration = call.duration_seconds ? `${call.duration_seconds}s` : "—";
  const date = new Date(call.created_at).toLocaleString();

  return (
    <div className="card p-0 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors text-left"
      >
        <Phone size={16} className="text-gray-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">{call.from_number || "Unknown"}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor(call.status)}`}>
              {call.status}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{date} · {duration} · {call.turns.length} turns</p>
        </div>
        <Clock size={14} className="text-gray-300" />
        {expanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
      </button>

      {expanded && call.turns.length > 0 && (
        <div className="px-5 pb-5 border-t border-gray-50 pt-4 space-y-3 bg-gray-50">
          {call.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
        </div>
      )}
      {expanded && call.turns.length === 0 && (
        <div className="px-5 pb-4 text-sm text-gray-400 border-t border-gray-50 pt-4">
          No conversation recorded.
        </div>
      )}
    </div>
  );
}

export default function AgentLogsPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getAgent(id), listCalls(id)])
      .then(([a, c]) => { setAgent(a); setCalls(c); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/dashboard/agents/${id}`} className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Call Logs{agent ? ` — ${agent.name}` : ""}</h1>
          <p className="text-gray-500 text-sm mt-0.5">Click a call to view the conversation transcript</p>
        </div>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Loading calls...</div>
      ) : calls.length === 0 ? (
        <div className="card text-center py-12">
          <Phone size={36} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No calls recorded yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}
