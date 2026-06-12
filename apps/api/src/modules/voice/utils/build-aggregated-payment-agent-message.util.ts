export function buildAggregatedPaymentAgentMessage(lineCount: number): string {
  const count = Math.max(1, Math.trunc(lineCount));
  if (count === 1) {
    return "I've sent the payment link to your email.";
  }
  return `I've sent one email with all ${count} books and a single secure payment link. Please check your inbox.`;
}
