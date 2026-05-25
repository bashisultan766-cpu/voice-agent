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
      return 'One moment while I check that for you.';
    case 'elevenlabs_timeout':
      return 'Still preparing my reply — just a second.';
    case 'shopify_delay':
      return 'Checking our catalog — this may take a moment.';
    case 'processing_timeout':
      return 'That is taking longer than usual. I am still here.';
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
  return 'Thanks for waiting. How can I help with your order?';
}
