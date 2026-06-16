/** Extract conv_... id from ElevenLabs register-call Stream TwiML. */
export function extractConversationIdFromTwiml(twiml: string): string | null {
  const match =
    twiml.match(/name=["']conversation_id["'][^>]*value=["']([^"']+)["']/i) ??
    twiml.match(/conversation_id["\s]*value=["']([^"']+)["']/i);
  return match?.[1]?.trim() || null;
}
export function twimlStructureFlags(twiml: string): {
  hasConnect: boolean;
  hasConversation: boolean;
  hasStream: boolean;
  hasResponse: boolean;
} {
  return {
    hasConnect: /<Connect\b/i.test(twiml),
    hasConversation: /<Conversation\b/i.test(twiml),
    hasStream: /<Stream\b/i.test(twiml),
    hasResponse: /<Response\b/i.test(twiml),
  };
}

/**
 * Mask secrets in TwiML for logs and debug endpoints.
 * Preserves structure (tags, attributes) while redacting tokens in URLs and auth-like values.
 */
export function sanitizeTwiMLForLogging(twiml: string): string {
  let out = twiml;

  // Query-string secrets on wss/https URLs inside attributes.
  out = out.replace(
    /([?&](?:token|api[_-]?key|signature|auth|access_token|secret|key)=)([^"&\s<>]+)/gi,
    '$1***',
  );

  // Bearer tokens embedded in attribute values.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');

  // ElevenLabs / generic API key patterns.
  out = out.replace(/\bsk_[a-zA-Z0-9]{8,}\b/g, 'sk_***');
  out = out.replace(/\bxi-[a-zA-Z0-9]{16,}\b/g, 'xi-***');

  // E.164 phone numbers in attribute values.
  out = out.replace(/\+[1-9]\d{6,14}/g, (match) => `***${match.slice(-4)}`);

  return out;
}

/**
 * Apply minimal repairs only when TwiML is clearly malformed.
 * Valid ElevenLabs register-call TwiML is returned unchanged.
 */
export function repairTwimlIfMalformed(raw: string): { twiml: string; repaired: boolean; reason: string | null } {
  let twiml = raw.trim();

  if (!twiml) {
    return { twiml, repaired: false, reason: 'empty' };
  }

  // JSON string literal accidentally returned (double-encoded).
  if (twiml.startsWith('"') && twiml.endsWith('"')) {
    try {
      const unquoted = JSON.parse(twiml) as string;
      if (typeof unquoted === 'string' && unquoted.includes('<Response')) {
        return { twiml: unquoted.trim(), repaired: true, reason: 'json_string_literal' };
      }
    } catch {
      // keep original
    }
  }

  // HTML-entity-encoded angle brackets (breaks Twilio XML parser).
  if (twiml.includes('&lt;Response') || twiml.includes('&lt;Connect')) {
    const decoded = twiml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    if (decoded.includes('<Response')) {
      return { twiml: decoded.trim(), repaired: true, reason: 'html_entities' };
    }
  }

  return { twiml, repaired: false, reason: null };
}
