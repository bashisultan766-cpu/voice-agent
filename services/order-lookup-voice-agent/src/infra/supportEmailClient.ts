import {
  sendSupportEscalationDetailed,
  type SupportEscalationDetails,
} from "../utils/resendEmailService.js";

/** Infrastructure boundary for support notifications. */
export async function sendSupportCaseEmail(
  details: SupportEscalationDetails,
): Promise<{ ok: boolean; error?: string }> {
  return sendSupportEscalationDetailed(details);
}
