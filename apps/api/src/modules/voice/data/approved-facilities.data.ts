export type FacilityApprovalStatus = 'approved' | 'not_approved' | 'unknown' | 'restricted';

export type ApprovedFacilityRecord = {
  id: string;
  name: string;
  aliases: string[];
  city?: string;
  state?: string;
  status: Exclude<FacilityApprovalStatus, 'unknown'>;
  accepts_books: boolean;
  accepts_hardcover: boolean;
  accepts_paperback: boolean;
  max_books_per_order: number | null;
  restricted_categories: string[];
  notes: string;
  last_verified_at: string;
};

/** SureShot Books approved facility list — update when client provides new facilities. */
export const APPROVED_FACILITIES: ApprovedFacilityRecord[] = [
  {
    id: 'cdcr-san-quentin',
    name: 'San Quentin State Prison',
    aliases: ['san quentin', 'cdcr san quentin', 'sqsp'],
    city: 'San Quentin',
    state: 'CA',
    status: 'approved',
    accepts_books: true,
    accepts_hardcover: true,
    accepts_paperback: true,
    max_books_per_order: 10,
    restricted_categories: ['explicit', 'gang-related'],
    notes: 'Books must be paperback or hardcover. No magazines.',
    last_verified_at: '2025-11-01',
  },
  {
    id: 'cdcr-pelican-bay',
    name: 'Pelican Bay State Prison',
    aliases: ['pelican bay', 'pbsp'],
    city: 'Crescent City',
    state: 'CA',
    status: 'approved',
    accepts_books: true,
    accepts_hardcover: false,
    accepts_paperback: true,
    max_books_per_order: 5,
    restricted_categories: ['explicit', 'hardcover'],
    notes: 'Paperback only. Hardcover not accepted.',
    last_verified_at: '2025-10-15',
  },
  {
    id: 'example-restricted',
    name: 'Example Restricted Facility',
    aliases: ['restricted facility demo'],
    city: 'Example',
    state: 'TX',
    status: 'restricted',
    accepts_books: true,
    accepts_hardcover: true,
    accepts_paperback: true,
    max_books_per_order: 3,
    restricted_categories: ['true crime', 'explicit'],
    notes: 'Some categories require staff review before shipping.',
    last_verified_at: '2025-09-01',
  },
];
