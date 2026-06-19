export interface Tenant {
  id: string;
  name: string;
  email: string;
  api_key: string;
  plan: string;
  is_active: boolean;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  tenant: Tenant;
}

export interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  shopify_store_url: string | null;
  llm_provider: string;
  llm_model: string;
  tts_provider: string;
  voice_id: string;
  system_prompt: string;
  twilio_phone_number: string | null;
  enabled_tools: string[];
  from_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentCreate {
  name: string;
  description?: string;
  shopify_store_url?: string;
  shopify_api_key?: string;
  llm_provider?: string;
  llm_model?: string;
  openai_api_key?: string;
  tts_provider?: string;
  voice_id?: string;
  system_prompt?: string;
  twilio_phone_number?: string;
  enabled_tools?: string[];
  from_email?: string;
  resend_api_key?: string;
}

export interface AgentUpdate extends Partial<AgentCreate> {
  is_active?: boolean;
}

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  latency_ms?: number;
  created_at: string;
}

export interface CallLog {
  id: string;
  agent_id: string | null;
  tenant_id: string;
  call_sid: string | null;
  from_number: string | null;
  to_number: string | null;
  status: string;
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  turns: ConversationTurn[];
}

export type LlmProvider = "openai" | "gemini" | "claude";
export type TtsProvider = "openai" | "twilio";
export type VoiceId = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

export const AVAILABLE_TOOLS = [
  { id: "product_search", label: "Product Search" },
  { id: "order_lookup", label: "Order Lookup" },
  { id: "checkout", label: "Checkout / Payment Link" },
  { id: "email", label: "Send Email" },
  { id: "customer_lookup", label: "Customer Lookup" },
  { id: "recommendation", label: "Product Recommendations" },
  { id: "conversation_state", label: "Conversation State" },
] as const;

export const LLM_MODELS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro"],
  claude: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
};

export const VOICE_OPTIONS: { id: VoiceId; label: string }[] = [
  { id: "alloy", label: "Alloy (Neutral)" },
  { id: "echo", label: "Echo (Male)" },
  { id: "fable", label: "Fable (British)" },
  { id: "onyx", label: "Onyx (Deep Male)" },
  { id: "nova", label: "Nova (Female)" },
  { id: "shimmer", label: "Shimmer (Soft Female)" },
];
