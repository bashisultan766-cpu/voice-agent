export type CredentialSource = 'agent' | 'workspace' | 'env' | 'missing';

export type ResolvedCredential = {
  value?: string;
  source: CredentialSource;
};

/** Prefer agent-specific secret, then workspace integration, then environment fallback. */
export function resolveCredentialPriority(
  agentValue: string | undefined,
  workspaceValue: string | undefined,
  envValue?: string | undefined,
): ResolvedCredential {
  if (agentValue?.trim()) return { value: agentValue.trim(), source: 'agent' };
  if (workspaceValue?.trim()) return { value: workspaceValue.trim(), source: 'workspace' };
  if (envValue?.trim()) return { value: envValue.trim(), source: 'env' };
  return { source: 'missing' };
}
