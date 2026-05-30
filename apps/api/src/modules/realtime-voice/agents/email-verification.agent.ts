import { Injectable } from '@nestjs/common';
import {
  captureEmailFromVoice,
  formatEmailForVoiceConfirmation,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  validateVoiceEmail,
} from '../../calls/runtime/voice-email-capture.util';
import { validateEnterpriseEmailSync } from '../../calls/runtime/voice-email-enterprise-validation.util';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

@Injectable()
export class EmailVerificationAgent {
  async verify(state: VoiceGraphState): Promise<AgentTaskResult> {
    const started = Date.now();
    const session = state.checkoutSession;

    if (session.stage === 'email_confirmation' && session.pendingEmail) {
      if (isEmailConfirmationAffirmative(state.utterance)) {
        return {
          agent: 'email_verification',
          ok: true,
          data: {
            valid: true,
            normalized: session.pendingEmail,
            confirmed: true,
          },
          latencyMs: Date.now() - started,
        };
      }
      if (isEmailConfirmationNegative(state.utterance)) {
        return {
          agent: 'email_verification',
          ok: false,
          data: { rejected: true },
          error: 'email_rejected',
          latencyMs: Date.now() - started,
        };
      }
    }

    const captured = captureEmailFromVoice(state.utterance, { mode: 'normal' });
    const raw =
      captured.email ??
      state.utterance.match(EMAIL_RE)?.[0]?.trim() ??
      '';

    if (!raw) {
      return {
        agent: 'email_verification',
        ok: false,
        error: 'no_email_found',
        latencyMs: Date.now() - started,
      };
    }

    const basic = validateVoiceEmail(raw);
    const enterprise = validateEnterpriseEmailSync(basic.normalized ?? raw);
    const normalized = enterprise.normalized ?? basic.normalized ?? raw.toLowerCase();
    const valid = enterprise.valid && basic.valid;

    if (!valid && enterprise.typoSuggestion?.correctedEmail) {
      const corrected = enterprise.typoSuggestion.correctedEmail;
      return {
        agent: 'email_verification',
        ok: true,
        data: {
          valid: true,
          normalized: corrected,
          corrected: true,
          original: raw,
          needsConfirmation: true,
          spellback: formatEmailForVoiceConfirmation(corrected),
        },
        latencyMs: Date.now() - started,
      };
    }

    return {
      agent: 'email_verification',
      ok: valid,
      data: {
        valid,
        normalized,
        raw,
        needsConfirmation: valid,
        spellback: valid ? formatEmailForVoiceConfirmation(normalized) : undefined,
      },
      error: valid ? undefined : enterprise.blockedReason ?? 'invalid_email',
      latencyMs: Date.now() - started,
    };
  }
}
