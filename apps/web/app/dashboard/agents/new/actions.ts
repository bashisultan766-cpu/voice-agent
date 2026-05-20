'use server';

import { cookies } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';
import {
  createAgentFullSchema,
  createAgentDraftSchema,
} from '@/lib/validation/create-agent.schema';
import {
  initialFormData,
  clampAgentPayloadForDraftApi,
  type CreateAgentFormData,
} from '@/components/agents/form-types';
import { toCheckoutModeApi } from '@bookstore-voice-agents/types';

export interface CreateAgentActionResult {
  ok: boolean;
  message: string;
  /** Present when create succeeded and API returned the new agent id. */
  agentId?: string;
}

function mergePayload(payload: unknown): CreateAgentFormData {
  const obj = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  return { ...initialFormData, ...obj } as CreateAgentFormData;
}

export async function createShopifyVoiceAgentAction(
  payload: unknown,
): Promise<CreateAgentActionResult> {
  const merged = mergePayload(payload);
  const savingDraft = merged.agentStatus === 'draft';

  if (savingDraft) {
    const draftNames = createAgentDraftSchema.safeParse(merged);
    if (!draftNames.success) {
      return {
        ok: false,
        message: draftNames.error.issues[0]?.message || 'Add agent and store names to save a draft.',
      };
    }
    const sanitized = clampAgentPayloadForDraftApi(merged);
    const parsed = createAgentFullSchema.safeParse(sanitized);
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues[0]?.message || 'Could not save draft — check optional URLs and emails.',
      };
    }
    return postAgentToApi(parsed.data);
  }

  const parsed = createAgentFullSchema.safeParse(merged);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message || 'Please complete required fields with valid values.',
    };
  }

  return postAgentToApi(parsed.data);
}

async function postAgentToApi(
  data: Record<string, unknown> & { promptTemplate?: string },
): Promise<CreateAgentActionResult> {
  const token = (await cookies()).get('va_access_token')?.value;
  if (!token) {
    return { ok: false, message: 'You are not authenticated.' };
  }

  const { promptTemplate: _, ...rest } = data;
  const body = {
    ...rest,
    escalationRules: Array.isArray(rest.escalationRules)
      ? rest.escalationRules
      : typeof rest.escalationRules === 'string'
        ? String(rest.escalationRules)
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0)
        : rest.escalationRules,
    checkoutMode: toCheckoutModeApi(rest.checkoutMode as string | undefined),
  };

  const response = await fetch(`${getServerApiBaseUrl()}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const result = (await response.json().catch(() => ({}))) as { message?: string; id?: string };
  if (!response.ok) {
    return { ok: false, message: result.message || 'Failed to create agent.' };
  }

  return { ok: true, message: 'Agent created successfully.', agentId: result.id };
}

/** Live Shopify Admin API check via Nest (same logic as dashboard connection tests). */
export async function testShopifyConnectionAction(input: {
  shopifyStoreUrl?: string;
  shopifyAdminToken?: string;
}): Promise<{ success: boolean; message: string }> {
  const domain = (input.shopifyStoreUrl || '').trim();
  const adminToken = (input.shopifyAdminToken || '').trim();
  if (!domain || !adminToken) {
    return { success: false, message: 'Enter both Shopify store domain and admin access token.' };
  }

  const token = (await cookies()).get('va_access_token')?.value;
  if (!token) {
    return { success: false, message: 'You are not authenticated.' };
  }

  const response = await fetch(`${getServerApiBaseUrl()}/api/agents/test-credentials/shopify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shopifyStoreUrl: domain,
      shopifyAdminToken: adminToken,
    }),
    cache: 'no-store',
  });

  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    message?: string;
  };

  if (!response.ok) {
    return {
      success: false,
      message: data.message || 'Shopify connection test failed. Check domain, token, and API scopes.',
    };
  }

  return {
    success: data.success === true,
    message:
      data.message ||
      (data.success ? 'Connected to Shopify successfully.' : 'Shopify connection test failed.'),
  };
}
