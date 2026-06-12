/**
 * Enterprise voice email validation — regex, disposable domains, typo correction, MX records.
 */

import { promises as dns } from 'node:dns';
import { normalizeSpokenEmail, VOICE_EMAIL_REGEX } from './spoken-email-normalizer.util';

/** Common spoken / ASR domain typos → canonical domain. */
const DOMAIN_TYPO_MAP: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmil.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'hotnail.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'iclod.com': 'icloud.com',
  'protonmial.com': 'protonmail.com',
  /** SureShot Books — common voice/ASR domain mishearings */
  'sureshoebooks.com': 'sureshotbooks.com',
  'sureshoebook.com': 'sureshotbooks.com',
  'sureshotbook.com': 'sureshotbooks.com',
  'shoreshortbooks.com': 'sureshotbooks.com',
  'shoreshortbook.com': 'sureshotbooks.com',
  'sureshortbooks.com': 'sureshotbooks.com',
};

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  '10minutemail.com',
  'throwaway.email',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'fakeinbox.com',
]);

export type EmailTypoSuggestion = {
  fromDomain: string;
  toDomain: string;
  correctedEmail: string;
};

export type EnterpriseEmailValidation = {
  valid: boolean;
  normalized: string;
  raw: string;
  regexValid: boolean;
  disposable: boolean;
  mxValid: boolean | null;
  mxChecked: boolean;
  typoSuggestion: EmailTypoSuggestion | null;
  blockedReason: 'invalid_format' | 'disposable' | 'mx_missing' | 'typo_pending' | null;
};

export type MxResolver = (domain: string) => Promise<boolean>;

export const MX_CHECK_TIMEOUT_MS = 3500;

export async function defaultMxResolver(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at >= email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

export function detectDomainTypo(domain: string): string | null {
  const d = domain.trim().toLowerCase();
  return DOMAIN_TYPO_MAP[d] ?? null;
}

export function buildTypoCorrectedEmail(email: string, suggestedDomain: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email.slice(0, at + 1)}${suggestedDomain}`;
}

export function suggestEmailTypo(normalizedEmail: string): EmailTypoSuggestion | null {
  const domain = extractEmailDomain(normalizedEmail);
  if (!domain) return null;
  const suggested = detectDomainTypo(domain);
  if (!suggested || suggested === domain) return null;
  return {
    fromDomain: domain,
    toDomain: suggested,
    correctedEmail: buildTypoCorrectedEmail(normalizedEmail, suggested),
  };
}

export function isDisposableEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  return (
    d.endsWith('.mailinator.com') ||
    d.endsWith('.guerrillamail.com') ||
    d.endsWith('.tempmail.com')
  );
}

export function validateEnterpriseEmailSync(raw: string): EnterpriseEmailValidation {
  const normalized = normalizeSpokenEmail(raw);
  const regexValid = VOICE_EMAIL_REGEX.test(normalized);
  const domain = extractEmailDomain(normalized);
  const disposable = domain ? isDisposableEmailDomain(domain) : false;
  const typoSuggestion = regexValid ? suggestEmailTypo(normalized) : null;

  let blockedReason: EnterpriseEmailValidation['blockedReason'] = null;
  if (!regexValid) {
    blockedReason = 'invalid_format';
  } else if (disposable) {
    blockedReason = 'disposable';
  } else if (typoSuggestion) {
    blockedReason = 'typo_pending';
  }

  const valid = regexValid && !disposable && !typoSuggestion;

  return {
    valid,
    normalized,
    raw: raw.trim(),
    regexValid,
    disposable,
    mxValid: null,
    mxChecked: false,
    typoSuggestion,
    blockedReason,
  };
}

export async function validateEnterpriseEmail(
  raw: string,
  options?: {
    mxResolver?: MxResolver;
    skipMx?: boolean;
    mxTimeoutMs?: number;
  },
): Promise<EnterpriseEmailValidation> {
  const base = validateEnterpriseEmailSync(raw);
  if (!base.regexValid || base.disposable || base.typoSuggestion) {
    return base;
  }

  if (options?.skipMx) {
    return { ...base, valid: true, mxValid: null, mxChecked: false };
  }

  const domain = extractEmailDomain(base.normalized);
  if (!domain) {
    return { ...base, valid: false, blockedReason: 'invalid_format' };
  }

  const resolver = options?.mxResolver ?? defaultMxResolver;
  const timeoutMs = options?.mxTimeoutMs ?? MX_CHECK_TIMEOUT_MS;

  let mxValid = false;
  try {
    mxValid = await Promise.race([
      resolver(domain),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('mx_timeout')), timeoutMs),
      ),
    ]);
  } catch {
    mxValid = false;
  }

  if (!mxValid) {
    return {
      ...base,
      valid: false,
      mxValid: false,
      mxChecked: true,
      blockedReason: 'mx_missing',
    };
  }

  return {
    ...base,
    valid: true,
    mxValid: true,
    mxChecked: true,
    blockedReason: null,
  };
}

export type EnterpriseEmailValidationLogInput = {
  callSessionId?: string;
  tenantId?: string;
  agentId?: string;
  maskedEmail?: string;
  regexValid: boolean;
  disposable: boolean;
  mxValid: boolean | null;
  mxChecked: boolean;
  typoFromDomain?: string;
  typoToDomain?: string;
  valid: boolean;
  blockedReason?: string | null;
};

export function buildEnterpriseEmailValidationLog(
  input: EnterpriseEmailValidationLogInput,
): Record<string, unknown> {
  return {
    event: 'voice.email.enterprise_validated',
    ...(input.callSessionId ? { callSessionId: input.callSessionId } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.maskedEmail ? { maskedEmail: input.maskedEmail } : {}),
    regexValid: input.regexValid,
    disposable: input.disposable,
    mxValid: input.mxValid,
    mxChecked: input.mxChecked,
    valid: input.valid,
    ...(input.typoFromDomain ? { typoFromDomain: input.typoFromDomain } : {}),
    ...(input.typoToDomain ? { typoToDomain: input.typoToDomain } : {}),
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
  };
}
