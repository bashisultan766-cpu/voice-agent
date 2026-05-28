export type StreamingFallbackReason =
  | 'openai_slow'
  | 'openai_timeout'
  | 'elevenlabs_timeout'
  | 'shopify_delay'
  | 'processing_timeout';

export function stallAcknowledgement(reason: StreamingFallbackReason): string {
  switch (reason) {
    case 'openai_slow':
    case 'openai_timeout':
      return 'Bear with me one moment while I pull that up.';
    case 'elevenlabs_timeout':
      return 'Still preparing my reply.';
    case 'shopify_delay':
      return 'I am checking our catalog now.';
    case 'processing_timeout':
      return 'I am still here. This is taking a bit longer than usual.';
    default:
      return 'One moment please.';
  }
}

export function recoveryLineAfterFallback(reason: StreamingFallbackReason): string {
  if (reason === 'processing_timeout') {
    return 'Sorry for the wait. Please repeat your question, or say the book title again.';
  }
  if (reason === 'elevenlabs_timeout') {
    return 'I can still help — what title should I look up?';
  }
  return 'Thanks for waiting. What book can I help you with?';
}
