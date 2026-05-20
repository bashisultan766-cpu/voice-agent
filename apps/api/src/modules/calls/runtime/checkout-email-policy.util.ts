export function isEmailRequiredBeforeCheckout(params: {
  askEmailBeforePaymentLink?: boolean | null;
  customerEmail?: string | null;
  destinationEmail?: string | null;
}) {
  const askEmail = params.askEmailBeforePaymentLink !== false;
  if (!askEmail) return false;
  return !(params.customerEmail?.trim() || params.destinationEmail?.trim());
}
