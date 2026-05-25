'use client';

import type { AgentToolPermissions } from '@bookstore-voice-agents/types';
import { DEFAULT_TOOL_PERMISSIONS } from '@bookstore-voice-agents/types';

const LABELS: Array<{ key: keyof AgentToolPermissions; label: string; description: string }> = [
  { key: 'productCatalog', label: 'Product catalog', description: 'Search, inventory, variants, pricing' },
  { key: 'checkoutCreation', label: 'Checkout creation', description: 'Draft orders and payment links' },
  { key: 'emailSending', label: 'Email sending', description: 'Send payment link emails' },
  { key: 'orderTracking', label: 'Order tracking', description: 'Look up order status' },
  { key: 'refunds', label: 'Refunds & returns', description: 'Return policy tools' },
  { key: 'discounts', label: 'Discounts', description: 'Promotions and discount lookup' },
  { key: 'faqRetrieval', label: 'FAQ retrieval', description: 'Store FAQ search' },
  { key: 'knowledgeBase', label: 'Knowledge base (RAG)', description: 'Vector + policy document retrieval' },
  { key: 'supportEscalation', label: 'Support escalation', description: 'Human handoff and callbacks' },
];

export interface ToolPermissionsSectionProps {
  value: AgentToolPermissions;
  onChange: (next: AgentToolPermissions) => void;
  disabled?: boolean;
}

export function ToolPermissionsSection({ value, onChange, disabled }: ToolPermissionsSectionProps) {
  const merged = { ...DEFAULT_TOOL_PERMISSIONS, ...value };

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h3 className="text-sm font-semibold">Tool permissions</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Only enabled tools are exposed to the OpenAI runtime for this agent.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {LABELS.map(({ key, label, description }) => (
          <label
            key={key}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/40"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={merged[key] !== false}
              disabled={disabled}
              onChange={(e) => onChange({ ...merged, [key]: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
