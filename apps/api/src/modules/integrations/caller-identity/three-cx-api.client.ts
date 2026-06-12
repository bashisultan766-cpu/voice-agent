import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ThreeCxTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type?: string;
};

export type ThreeCxContactRecord = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  company: string | null;
  phones: string[];
  raw: Record<string, unknown>;
};

export type ThreeCxCallHistoryRecord = {
  segmentId: string;
  startedAt: string | null;
  direction: string | null;
  srcDisplayName: string | null;
  dstDisplayName: string | null;
  srcDn: string | null;
  dstDn: string | null;
  durationSeconds: number | null;
  answered: boolean | null;
  recordingId: string | null;
  raw: Record<string, unknown>;
};

export type ThreeCxRecordingRecord = {
  id: string;
  startedAt: string | null;
  caller: string | null;
  callee: string | null;
  durationSeconds: number | null;
  raw: Record<string, unknown>;
};

const PHONE_FIELD_KEYS = [
  'PhoneNumber',
  'Phone',
  'Mobile',
  'PhoneMobile',
  'MobileNumber',
  'Business',
  'BusinessPhone',
  'PhoneBusiness',
  'Home',
  'HomePhone',
  'Other',
  'Fax',
  'Number',
];

const CONTACT_NAME_KEYS = {
  first: ['FirstName', 'First', 'GivenName'],
  last: ['LastName', 'Last', 'Surname', 'FamilyName'],
  display: ['DisplayName', 'Name', 'FullName'],
  email: ['Email', 'EmailAddress', 'Mail'],
  company: ['Company', 'CompanyName', 'Organization'],
};

@Injectable()
export class ThreeCxApiClient {
  private readonly logger = new Logger(ThreeCxApiClient.name);
  private cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl() && this.clientId() && this.clientSecret());
  }

  /** Lightweight auth + API probe for deployment health checks. */
  async probeConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.isConfigured()) {
      return { ok: false, message: '3CX credentials are not configured.' };
    }

    try {
      await this.xapiGet<{ Version?: string }>('/SystemStatus');
      return { ok: true, message: '3CX API reachable and authenticated.' };
    } catch (err) {
      try {
        await this.xapiGet('/Defs', { $top: '1', $select: 'Id' });
        return { ok: true, message: '3CX API reachable and authenticated.' };
      } catch (fallbackErr) {
        const message =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return { ok: false, message: message.slice(0, 300) };
      }
    }
  }

  baseUrl(): string {
    return (this.config.get<string>('THREE_CX_BASE_URL')?.trim() || '').replace(/\/$/, '');
  }

  private clientId(): string {
    return this.config.get<string>('THREE_CX_CLIENT_ID')?.trim() || '';
  }

  private clientSecret(): string {
    return this.config.get<string>('THREE_CX_CLIENT_SECRET')?.trim() || '';
  }

  async findContactByPhone(rawPhone: string): Promise<ThreeCxContactRecord | null> {
    if (!this.isConfigured()) return null;

    const digits = (rawPhone ?? '').replace(/\D/g, '');
    if (!digits) return null;

    const escaped = escapeODataString(digits);
    const filterParts = PHONE_FIELD_KEYS.map((field) => `contains(${field},'${escaped}')`);
    const filter = filterParts.join(' or ');

    try {
      const data = await this.xapiGet<{ value?: unknown[] }>('/Contacts', {
        $filter: filter,
        $top: '25',
      });
      const match = this.pickContactMatch(data.value ?? [], rawPhone);
      if (match) return match;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.contacts_filter_failed',
          message: message.slice(0, 300),
        }),
      );
    }

    try {
      const fallback = await this.xapiGet<{ value?: unknown[] }>('/Contacts', {
        $orderby: 'LastName',
        $top: '500',
      });
      return this.pickContactMatch(fallback.value ?? [], rawPhone);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.contacts_list_failed',
          message: message.slice(0, 300),
        }),
      );
      return null;
    }
  }

  async createContact(input: {
    phone: string;
    firstName?: string;
    lastName?: string;
    displayName?: string;
    email?: string;
    company?: string;
  }): Promise<ThreeCxContactRecord | null> {
    if (!this.isConfigured()) return null;

    const firstName = input.firstName?.trim() || splitFirst(input.displayName);
    const lastName = input.lastName?.trim() || splitLast(input.displayName);
    const phone = input.phone.trim();

    const body: Record<string, unknown> = {
      FirstName: firstName || 'Caller',
      LastName: lastName || '',
      PhoneNumber: phone,
      Mobile: phone,
      Email: input.email?.trim() || undefined,
      Company: input.company?.trim() || undefined,
    };

    try {
      const created = await this.xapiPost<Record<string, unknown>>('/Contacts', body);
      return this.mapContact(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'three_cx.contact_create_failed',
          message: message.slice(0, 400),
        }),
      );
      return null;
    }
  }

  async getCallHistoryForPhone(rawPhone: string, limit = 25): Promise<ThreeCxCallHistoryRecord[]> {
    if (!this.isConfigured()) return [];

    const digits = (rawPhone ?? '').replace(/\D/g, '');
    if (!digits) return [];

    try {
      const data = await this.xapiGet<{ value?: unknown[] }>('/CallHistoryView', {
        $orderby: 'SegmentStartTime desc',
        $top: String(Math.min(Math.max(limit * 4, 50), 500)),
        $select:
          'SegmentId,SegmentStartTime,SrcDn,DstDn,SrcExtendedDisplayName,DstExtendedDisplayName,CallTime,CallAnswered,RecId,RecordingId,CallDirection',
      });

      const rows = (data.value ?? [])
        .map((row) => this.mapCallHistory(row))
        .filter((row) => this.historyRowMatchesPhone(row, digits, rawPhone));

      return rows.slice(0, limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.call_history_failed',
          message: message.slice(0, 300),
        }),
      );
      return [];
    }
  }

  async getRecordingsForPhone(rawPhone: string, limit = 10): Promise<ThreeCxRecordingRecord[]> {
    if (!this.isConfigured()) return [];

    const digits = (rawPhone ?? '').replace(/\D/g, '');
    if (!digits) return [];

    try {
      const data = await this.xapiGet<{ value?: unknown[] }>('/Recordings', {
        $orderby: 'StartTime desc',
        $top: String(Math.min(Math.max(limit * 4, 40), 200)),
      });

      return (data.value ?? [])
        .map((row) => this.mapRecording(row))
        .filter((row) => this.recordingMatchesPhone(row, digits, rawPhone))
        .slice(0, limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.recordings_list_failed',
          message: message.slice(0, 300),
        }),
      );
      return [];
    }
  }

  async downloadRecording(recId: string): Promise<{ body: ArrayBuffer; contentType: string }> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl()}/xapi/v1/Recordings/Pbx.DownloadRecording(recId=${encodeURIComponent(recId)})`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'audio/*, application/octet-stream, */*',
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`3CX recording download failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') || 'audio/wav';
    const body = await res.arrayBuffer();
    return { body, contentType };
  }

  recordingDownloadPath(recId: string, publicBaseUrl: string, accessToken?: string): string {
    const base = publicBaseUrl.replace(/\/$/, '');
    const token =
      accessToken?.trim() ||
      this.config.get<string>('THREE_CX_RECORDINGS_TOKEN')?.trim() ||
      this.config.get<string>('THREE_CX_CRM_TOKEN')?.trim() ||
      '';
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${base}/api/integrations/3cx/recordings/${encodeURIComponent(recId)}/download${qs}`;
  }

  private async xapiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl()}/xapi/v1${path.startsWith('/') ? path : `/${path}`}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`3CX GET ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }

    return (await res.json()) as T;
  }

  private async xapiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl()}/xapi/v1${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`3CX POST ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const raw = await res.text();
    if (!raw.trim()) return {} as T;
    return JSON.parse(raw) as T;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now + 30_000) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      grant_type: 'client_credentials',
    });

    const res = await fetch(`${this.baseUrl()}/connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`3CX token request failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const parsed = (await res.json()) as ThreeCxTokenResponse;
    const accessToken = parsed.access_token?.trim();
    if (!accessToken) {
      throw new Error('3CX token response missing access_token.');
    }

    const ttlSec = Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) : 3600;
    this.cachedToken = {
      accessToken,
      expiresAtMs: now + ttlSec * 1000,
    };

    return accessToken;
  }

  private pickContactMatch(rows: unknown[], rawPhone: string): ThreeCxContactRecord | null {
    const digits = (rawPhone ?? '').replace(/\D/g, '');
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const contact = this.mapContact(row as Record<string, unknown>);
      if (contact.phones.some((p) => phonesShareDigits(p, digits))) {
        return contact;
      }
    }
    return null;
  }

  private mapContact(row: Record<string, unknown>): ThreeCxContactRecord {
    const id = String(row.Id ?? row.ContactId ?? row.id ?? '');
    const firstName = pickField(row, CONTACT_NAME_KEYS.first);
    const lastName = pickField(row, CONTACT_NAME_KEYS.last);
    const displayName =
      pickField(row, CONTACT_NAME_KEYS.display) ||
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      null;

    const phones = PHONE_FIELD_KEYS.map((key) => stringOrEmpty(row[key])).filter(Boolean);

    return {
      id,
      firstName,
      lastName,
      displayName,
      email: pickField(row, CONTACT_NAME_KEYS.email),
      company: pickField(row, CONTACT_NAME_KEYS.company),
      phones,
      raw: row,
    };
  }

  private mapCallHistory(row: unknown): ThreeCxCallHistoryRecord {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const segmentId = String(record.SegmentId ?? record.Id ?? '');
    const startedAt = stringOrEmpty(record.SegmentStartTime ?? record.StartTime) || null;
    const durationRaw = record.CallTime ?? record.Duration;
    const durationSeconds =
      typeof durationRaw === 'number'
        ? durationRaw
        : typeof durationRaw === 'string' && durationRaw.trim()
          ? Number(durationRaw)
          : null;

    return {
      segmentId,
      startedAt,
      direction: stringOrEmpty(record.CallDirection ?? record.Direction) || null,
      srcDisplayName: stringOrEmpty(record.SrcExtendedDisplayName) || null,
      dstDisplayName: stringOrEmpty(record.DstExtendedDisplayName) || null,
      srcDn: stringOrEmpty(record.SrcDn) || null,
      dstDn: stringOrEmpty(record.DstDn) || null,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      answered:
        typeof record.CallAnswered === 'boolean'
          ? record.CallAnswered
          : String(record.CallAnswered ?? '').toLowerCase() === 'true',
      recordingId: stringOrEmpty(record.RecId ?? record.RecordingId) || null,
      raw: record,
    };
  }

  private mapRecording(row: unknown): ThreeCxRecordingRecord {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const durationRaw = record.Duration ?? record.CallTime;
    const durationSeconds =
      typeof durationRaw === 'number'
        ? durationRaw
        : typeof durationRaw === 'string' && durationRaw.trim()
          ? Number(durationRaw)
          : null;

    return {
      id: String(record.Id ?? record.RecId ?? record.RecordingId ?? ''),
      startedAt: stringOrEmpty(record.StartTime ?? record.SegmentStartTime) || null,
      caller: stringOrEmpty(record.SrcCallerNumber ?? record.Caller ?? record.From) || null,
      callee: stringOrEmpty(record.DstCallerNumber ?? record.Callee ?? record.To) || null,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      raw: record,
    };
  }

  private historyRowMatchesPhone(
    row: ThreeCxCallHistoryRecord,
    digits: string,
    rawPhone: string,
  ): boolean {
    const haystack = [
      row.srcDn,
      row.dstDn,
      row.srcDisplayName,
      row.dstDisplayName,
      JSON.stringify(row.raw),
    ]
      .filter(Boolean)
      .join(' ');
    return phonesShareDigits(haystack, digits) || phonesShareDigits(haystack, rawPhone);
  }

  private recordingMatchesPhone(
    row: ThreeCxRecordingRecord,
    digits: string,
    rawPhone: string,
  ): boolean {
    const haystack = [row.caller, row.callee, JSON.stringify(row.raw)].filter(Boolean).join(' ');
    return phonesShareDigits(haystack, digits) || phonesShareDigits(haystack, rawPhone);
  }
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function pickField(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringOrEmpty(row[key]);
    if (value) return value;
  }
  return null;
}

function stringOrEmpty(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function phonesShareDigits(a: string, b: string): boolean {
  const left = (a ?? '').replace(/\D/g, '');
  const right = (b ?? '').replace(/\D/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 10 && right.length >= 10) {
    return left.slice(-10) === right.slice(-10);
  }
  return left.endsWith(right) || right.endsWith(left);
}

function splitFirst(name?: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

function splitLast(name?: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}
