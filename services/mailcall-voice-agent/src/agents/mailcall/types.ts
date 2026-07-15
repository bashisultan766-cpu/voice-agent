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
  /** True when WordPress was unavailable and caller should use fallback speech. */
  degraded: boolean;
  /** Human-readable reason when degraded. */
  degradeReason?: string;
  cacheHit: boolean;
  latencyMs: number;
}

export interface CallTurnResult {
  speech: string;
  degraded: boolean;
  articlesUsed: number;
  latencyMs: number;
}

export const WP_UNAVAILABLE_SPEECH =
  "I am currently having trouble pulling up our latest articles, but I can help you with general inquiries. What else would you like to know about Mail Call Communication Newspaper?";

export const GREETING_SPEECH =
  "Thank you for calling Mail Call Communication Newspaper. I'm your editorial assistant. How can I help you today?";
