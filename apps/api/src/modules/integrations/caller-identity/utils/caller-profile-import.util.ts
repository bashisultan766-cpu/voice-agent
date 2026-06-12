import { normalizeCallerPhone } from './caller-phone.util';

export type ThreeCxContactImportRow = {
  phone: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  company?: string;
  externalId?: string;
};

const PHONE_HEADER_KEYS = [
  'phone',
  'phonenumber',
  'phone1',
  'phone2',
  'mobile',
  'mobilephone',
  'mobilephonenumber',
  'businessphone',
  'business',
  'homephone',
  'home',
  'number',
  'tel',
];

const FIRST_NAME_KEYS = ['firstname', 'first', 'givenname'];
const LAST_NAME_KEYS = ['lastname', 'last', 'surname', 'familyname'];
const DISPLAY_NAME_KEYS = ['name', 'displayname', 'contactname', 'fullname'];
const EMAIL_KEYS = ['email', 'emailaddress', 'mail'];
const COMPANY_KEYS = ['company', 'companyname', 'organization', 'org'];
const EXTERNAL_ID_KEYS = ['id', 'contactid', 'externalid', 'crmcontactid'];

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function pickField(row: Record<string, string>, keys: string[]): string | undefined {
  for (const [header, value] of Object.entries(row)) {
    const key = normalizeHeader(header);
    if (!keys.includes(key)) continue;
    const trimmed = (value ?? '').trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function buildDisplayName(firstName?: string, lastName?: string, displayName?: string): string {
  const explicit = (displayName ?? '').trim();
  if (explicit) return explicit;
  const parts = [firstName?.trim(), lastName?.trim()].filter(Boolean);
  return parts.join(' ').trim();
}

function collectPhones(row: Record<string, string>): string[] {
  const phones = new Set<string>();
  for (const [header, value] of Object.entries(row)) {
    const key = normalizeHeader(header);
    if (!PHONE_HEADER_KEYS.includes(key)) continue;
    const trimmed = (value ?? '').trim();
    if (!trimmed) continue;
    const { normalized } = normalizeCallerPhone(trimmed);
    if (normalized) phones.add(normalized);
  }
  return [...phones];
}

function rowToImportEntries(row: Record<string, string>): ThreeCxContactImportRow[] {
  const firstName = pickField(row, FIRST_NAME_KEYS);
  const lastName = pickField(row, LAST_NAME_KEYS);
  const displayName = buildDisplayName(
    firstName,
    lastName,
    pickField(row, DISPLAY_NAME_KEYS),
  );
  const email = pickField(row, EMAIL_KEYS);
  const company = pickField(row, COMPANY_KEYS);
  const externalId = pickField(row, EXTERNAL_ID_KEYS);
  const phones = collectPhones(row);

  if (phones.length === 0) return [];

  return phones.map((phone) => ({
    phone,
    firstName,
    lastName,
    displayName: displayName || undefined,
    email,
    company,
    externalId,
  }));
}

/** Parse 3CX / CRM CSV export (flexible column names). */
export function parseThreeCxContactsCsv(csv: string): ThreeCxContactImportRow[] {
  const lines = (csv ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const rows: ThreeCxContactImportRow[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    rows.push(...rowToImportEntries(record));
  }

  return dedupeImportRows(rows);
}

export function parseThreeCxContactsJson(data: unknown): ThreeCxContactImportRow[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { contacts?: unknown }).contacts)
      ? (data as { contacts: unknown[] }).contacts
      : [];

  const rows: ThreeCxContactImportRow[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const stringRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value == null) continue;
      stringRecord[key] = String(value);
    }
    rows.push(...rowToImportEntries(stringRecord));
  }

  return dedupeImportRows(rows);
}

function dedupeImportRows(rows: ThreeCxContactImportRow[]): ThreeCxContactImportRow[] {
  const byPhone = new Map<string, ThreeCxContactImportRow>();
  for (const row of rows) {
    const { normalized } = normalizeCallerPhone(row.phone);
    if (!normalized) continue;
    const existing = byPhone.get(normalized);
    if (!existing) {
      byPhone.set(normalized, { ...row, phone: normalized });
      continue;
    }
    byPhone.set(normalized, {
      ...existing,
      ...row,
      phone: normalized,
      displayName: row.displayName || existing.displayName,
      firstName: row.firstName || existing.firstName,
      lastName: row.lastName || existing.lastName,
      email: row.email || existing.email,
      company: row.company || existing.company,
      externalId: row.externalId || existing.externalId,
    });
  }
  return [...byPhone.values()];
}
