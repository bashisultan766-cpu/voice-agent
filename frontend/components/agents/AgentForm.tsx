"use client";
import { useState } from "react";
import { ChevronDown, ChevronUp, CheckSquare, Square } from "lucide-react";
import type { Agent, AgentCreate, AgentUpdate } from "@/lib/types";
import { AVAILABLE_TOOLS, LLM_MODELS, VOICE_OPTIONS } from "@/lib/types";
import clsx from "clsx";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI sales assistant. Help customers find products, check orders, and complete purchases. Always collect the customer's email before sending a payment link. Be friendly and concise.";

interface Props {
  initial?: Agent;
  onSubmit: (data: AgentCreate | AgentUpdate) => Promise<void>;
  loading?: boolean;
  error?: string;
}

type Section = "basic" | "shopify" | "llm" | "voice" | "prompt" | "tools" | "email";

export default function AgentForm({ initial, onSubmit, loading, error }: Props) {
  const [openSection, setOpenSection] = useState<Section>("basic");

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const [shopifyUrl, setShopifyUrl] = useState(initial?.shopify_store_url ?? "");
  const [shopifyKey, setShopifyKey] = useState("");

  const [llmProvider, setLlmProvider] = useState<"openai" | "gemini" | "claude">(
    (initial?.llm_provider as "openai") ?? "openai"
  );
  const [llmModel, setLlmModel] = useState(initial?.llm_model ?? "gpt-4o-mini");
  const [openaiKey, setOpenaiKey] = useState("");

  const [ttsProvider, setTtsProvider] = useState(initial?.tts_provider ?? "openai");
  const [voiceId, setVoiceId] = useState(initial?.voice_id ?? "alloy");
  const [twilioPhone, setTwilioPhone] = useState(initial?.twilio_phone_number ?? "");

  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? DEFAULT_SYSTEM_PROMPT);

  const [enabledTools, setEnabledTools] = useState<string[]>(
    initial?.enabled_tools ?? ["product_search", "order_lookup", "checkout", "email", "customer_lookup", "recommendation"]
  );

  const [fromEmail, setFromEmail] = useState(initial?.from_email ?? "");
  const [resendKey, setResendKey] = useState("");

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  function toggle(section: Section) {
    setOpenSection((prev) => (prev === section ? "basic" : section));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: AgentCreate = {
      name,
      description: description || undefined,
      shopify_store_url: shopifyUrl || undefined,
      shopify_api_key: shopifyKey || undefined,
      llm_provider: llmProvider,
      llm_model: llmModel,
      openai_api_key: openaiKey || undefined,
      tts_provider: ttsProvider,
      voice_id: voiceId,
      system_prompt: systemPrompt,
      twilio_phone_number: twilioPhone || undefined,
      enabled_tools: enabledTools,
      from_email: fromEmail || undefined,
      resend_api_key: resendKey || undefined,
    };
    await onSubmit(payload);
  }

  const sections: { id: Section; label: string }[] = [
    { id: "basic", label: "Basic Info" },
    { id: "shopify", label: "Shopify Connection" },
    { id: "llm", label: "LLM / AI Model" },
    { id: "voice", label: "Voice & TTS" },
    { id: "prompt", label: "System Prompt" },
    { id: "tools", label: "Tools" },
    { id: "email", label: "Email Settings" },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {sections.map(({ id, label }) => (
        <div key={id} className="card p-0 overflow-hidden">
          <button
            type="button"
            onClick={() => toggle(id)}
            className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            <span className="font-medium text-gray-900 text-sm">{label}</span>
            {openSection === id ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </button>

          {openSection === id && (
            <div className="px-5 pb-5 border-t border-gray-50 pt-4 space-y-4">
              {id === "basic" && (
                <>
                  <div>
                    <label className="label">Agent Name *</label>
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. SureShot Books Assistant" />
                  </div>
                  <div>
                    <label className="label">Description</label>
                    <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
                  </div>
                </>
              )}

              {id === "shopify" && (
                <>
                  <div>
                    <label className="label">Shopify Store URL</label>
                    <input className="input" value={shopifyUrl} onChange={(e) => setShopifyUrl(e.target.value)} placeholder="https://your-store.myshopify.com" />
                  </div>
                  <div>
                    <label className="label">Admin API Token {initial?.shopify_store_url && <span className="text-gray-400">(leave blank to keep current)</span>}</label>
                    <input type="password" className="input" value={shopifyKey} onChange={(e) => setShopifyKey(e.target.value)} placeholder="shpat_..." />
                  </div>
                </>
              )}

              {id === "llm" && (
                <>
                  <div>
                    <label className="label">LLM Provider</label>
                    <select className="input" value={llmProvider} onChange={(e) => { setLlmProvider(e.target.value as typeof llmProvider); setLlmModel(LLM_MODELS[e.target.value as typeof llmProvider][0]); }}>
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="claude">Anthropic Claude</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Model</label>
                    <select className="input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                      {LLM_MODELS[llmProvider].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">OpenAI API Key {initial && <span className="text-gray-400">(leave blank to keep current)</span>}</label>
                    <input type="password" className="input" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} placeholder="sk-..." />
                  </div>
                </>
              )}

              {id === "voice" && (
                <>
                  <div>
                    <label className="label">TTS Provider</label>
                    <select className="input" value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)}>
                      <option value="openai">OpenAI TTS</option>
                      <option value="twilio">Twilio (built-in, fastest)</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Voice</label>
                    <select className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Twilio Phone Number</label>
                    <input className="input" value={twilioPhone} onChange={(e) => setTwilioPhone(e.target.value)} placeholder="+15551234567" />
                    <p className="text-xs text-gray-400 mt-1">The Twilio number that routes calls to this agent.</p>
                  </div>
                </>
              )}

              {id === "prompt" && (
                <div>
                  <label className="label">System Prompt</label>
                  <textarea
                    className="input resize-none"
                    rows={10}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="You are a helpful AI assistant..."
                  />
                  <p className="text-xs text-gray-400 mt-1">Defines the agent's persona, behavior, and constraints.</p>
                </div>
              )}

              {id === "tools" && (
                <div className="space-y-2">
                  <p className="text-sm text-gray-500">Select which tools this agent can use during calls.</p>
                  {AVAILABLE_TOOLS.map((t) => {
                    const active = enabledTools.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleTool(t.id)}
                        className={clsx(
                          "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border text-sm text-left transition-colors",
                          active ? "border-brand-200 bg-brand-50 text-brand-700" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                        )}
                      >
                        {active ? <CheckSquare size={16} className="text-brand-500" /> : <Square size={16} className="text-gray-300" />}
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {id === "email" && (
                <>
                  <div>
                    <label className="label">From Email</label>
                    <input type="email" className="input" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="payments@yourstore.com" />
                  </div>
                  <div>
                    <label className="label">Resend API Key {initial && <span className="text-gray-400">(leave blank to keep current)</span>}</label>
                    <input type="password" className="input" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_..." />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      {error && <p className="error-text">{error}</p>}

      <button type="submit" disabled={loading} className="btn-primary w-full">
        {loading ? "Saving..." : initial ? "Save Changes" : "Create Agent"}
      </button>
    </form>
  );
}
