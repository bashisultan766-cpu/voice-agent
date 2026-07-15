export interface WpRenderedField {
  rendered?: string;
  protected?: boolean;
}

export interface WpPostRaw {
  id: number;
  date?: string;
  modified?: string;
  slug?: string;
  link?: string;
  title?: WpRenderedField | string;
  excerpt?: WpRenderedField | string;
  content?: WpRenderedField | string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WpCategoryRaw {
  id: number;
  name: string;
  slug: string;
  count?: number;
  description?: string;
}

/** Normalized, speech-ready article used by the conversational layer. */
export interface MailCallArticle {
  id: number;
  title: string;
  excerpt: string;
  content: string;
  spokenSummary: string;
  date?: string;
  slug?: string;
  categoryIds: number[];
  customFields: Record<string, unknown>;
}

export interface MailCallCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;
}

export interface KnowledgeHit {
  articles: MailCallArticle[];
  categories: MailCallCategory[];
  /** True when live CMS was unavailable (caller still gets natural brand speech). */
  degraded: boolean;
  /** Internal SRE reason — never spoken aloud. */
  degradeReason?: string;
  /** Served from static brand profile (identity or offline). */
  usedBrandProfile?: boolean;
  /** Ready-to-speak brand answer when usedBrandProfile is true. */
  brandSpeech?: string;
  /** LLM knowledge block for brand profile turns. */
  brandKnowledge?: string;
  cacheHit: boolean;
  latencyMs: number;
}

export interface CallTurnResult {
  speech: string;
  degraded: boolean;
  articlesUsed: number;
  latencyMs: number;
  usedBrandProfile?: boolean;
}

export const GREETING_SPEECH =
  "Thank you for calling Mail Call Communication. I'm your senior editorial representative. How can I help you with the newspaper today?";
