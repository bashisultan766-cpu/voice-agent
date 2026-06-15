import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  APPROVED_FACILITIES,
  type ApprovedFacilityRecord,
  type FacilityApprovalStatus,
} from '../data/approved-facilities.data';
import { sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';

export type FacilityApprovalResult = {
  success: boolean;
  status: FacilityApprovalStatus;
  facility_name: string | null;
  matched_facility_id: string | null;
  rules: {
    accepts_books: boolean;
    accepts_hardcover: boolean;
    accepts_paperback: boolean;
    max_books_per_order: number | null;
    restricted_categories: string[];
    notes: string;
    last_verified_at: string | null;
  } | null;
  suggested_response: string;
  escalate?: boolean;
  escalation_reason?: string;
};

function normalizeFacilityToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreFacilityMatch(
  record: ApprovedFacilityRecord,
  args: { facilityName: string; city?: string; state?: string },
): number {
  const name = normalizeFacilityToken(args.facilityName);
  const city = args.city ? normalizeFacilityToken(args.city) : '';
  const state = args.state ? normalizeFacilityToken(args.state) : '';
  let score = 0;

  const recordName = normalizeFacilityToken(record.name);
  if (name === recordName) score += 100;
  else if (recordName.includes(name) || name.includes(recordName)) score += 60;

  for (const alias of record.aliases) {
    const a = normalizeFacilityToken(alias);
    if (name === a || name.includes(a) || a.includes(name)) score += 50;
  }

  if (city && record.city && normalizeFacilityToken(record.city) === city) score += 20;
  if (state && record.state && normalizeFacilityToken(record.state) === state) score += 15;

  return score;
}

@Injectable()
export class FacilityApprovalService {
  private readonly logger = new Logger(FacilityApprovalService.name);

  checkFacilityApproval(args: {
    facilityName: string;
    state?: string;
    city?: string;
    callSid?: string;
  }): FacilityApprovalResult {
    const facilityName = args.facilityName?.trim();
    if (!facilityName) throw new BadRequestException('facility_name is required.');

    const ranked = APPROVED_FACILITIES.map((record) => ({
      record,
      score: scoreFacilityMatch(record, {
        facilityName,
        city: args.city,
        state: args.state,
      }),
    }))
      .filter((r) => r.score >= 40)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
      const suggested =
        'I do not have this facility on our verified approval list. I will connect you with customer service to confirm whether we can ship there.';
      this.logger.log(
        JSON.stringify({
          event: 'voice.facility.approval_unknown',
          facilityName: facilityName.slice(0, 80),
          callSid: args.callSid ?? null,
        }),
      );
      return {
        success: true,
        status: 'unknown',
        facility_name: facilityName,
        matched_facility_id: null,
        rules: null,
        suggested_response: suggested,
        escalate: true,
        escalation_reason: 'facility_approval_unknown',
      };
    }

    const best = ranked[0].record;
    const status: FacilityApprovalStatus = best.status;

    const rules = {
      accepts_books: best.accepts_books,
      accepts_hardcover: best.accepts_hardcover,
      accepts_paperback: best.accepts_paperback,
      max_books_per_order: best.max_books_per_order,
      restricted_categories: best.restricted_categories,
      notes: best.notes,
      last_verified_at: best.last_verified_at,
    };

    let suggested: string;
    if (status === 'approved') {
      suggested = `Yes, ${best.name} is on our approved facility list. ${best.notes}`;
      if (!best.accepts_hardcover) {
        suggested += ' Please note: hardcover books are not accepted at this facility.';
      }
    } else if (status === 'restricted') {
      suggested = `${best.name} is on our list with restrictions. ${best.notes} Some books may require staff review before shipping.`;
    } else {
      suggested = `${best.name} is not approved for SureShot Books shipments. I can connect you with customer service for alternatives.`;
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.facility.approval_checked',
        facilityName: facilityName.slice(0, 80),
        matchedId: best.id,
        status,
        callSid: args.callSid ?? null,
      }),
    );

    return {
      success: true,
      status,
      facility_name: best.name,
      matched_facility_id: best.id,
      rules,
      suggested_response: sanitizeCustomerFacingText(suggested),
      escalate: status === 'restricted',
      escalation_reason: status === 'restricted' ? 'restricted_book' : undefined,
    };
  }
}
