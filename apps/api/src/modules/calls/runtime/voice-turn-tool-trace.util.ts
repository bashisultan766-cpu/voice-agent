import type { ToolResult } from './tool-orchestrator.service';

/** Summaries of tool outcomes for deterministic TTS; model reply text is ignored when these apply. */
export interface VoiceTurnToolTrace {
  searchProducts?: {
    ok: boolean;
    found: boolean;
    title?: string;
    price?: string | null;
    requiresClarification: boolean;
    /** Present when ok is false — used to distinguish catalog failures from policy blocks. */
    errorCode?: string;
  };
  validateEmail?: {
    valid: boolean;
    email: string | null;
  };
  sendPaymentEmail?: {
    ok: boolean;
    deduplicated?: boolean;
    email?: string;
  };
}

export function applyVoiceToolTrace(
  trace: VoiceTurnToolTrace,
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: ToolResult,
): void {
  switch (toolName) {
    case 'searchProducts':
      if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        const d = result.data as Record<string, unknown>;
        const results = Array.isArray(d.results) ? d.results : [];
        const top = results[0] as Record<string, unknown> | undefined;
        const variants = Array.isArray(top?.variants) ? (top.variants as Record<string, unknown>[]) : [];
        const v0 = variants[0];
        trace.searchProducts = {
          ok: true,
          found: results.length > 0,
          title: typeof top?.title === 'string' ? top.title : undefined,
          price: typeof v0?.price === 'string' ? v0.price : null,
          requiresClarification: d.requiresClarification === true,
        };
      } else {
        const err = result.error && typeof result.error === 'object' ? (result.error as { code?: string }) : null;
        trace.searchProducts = {
          ok: false,
          found: false,
          requiresClarification: false,
          errorCode: typeof err?.code === 'string' ? err.code : undefined,
        };
      }
      break;
    case 'validateEmail':
      if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        const d = result.data as Record<string, unknown>;
        trace.validateEmail = {
          valid: d.valid === true,
          email: typeof d.normalizedEmail === 'string' ? d.normalizedEmail : null,
        };
      }
      break;
    case 'sendPaymentEmail': {
      const emailArg = typeof toolArgs.email === 'string' ? toolArgs.email.trim() : '';
      if (result.ok && result.data && typeof result.data === 'object') {
        const d = result.data as Record<string, unknown>;
        trace.sendPaymentEmail = {
          ok: true,
          deduplicated: d.deduplicated === true,
          email: emailArg || undefined,
        };
      } else {
        trace.sendPaymentEmail = {
          ok: false,
          email: emailArg || undefined,
        };
      }
      break;
    }
    default:
      break;
  }
}
