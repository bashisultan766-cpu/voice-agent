import { expandQueryTokens, normalizeBookTitleForSearch } from './bookstore-title-normalizer.util';

const VOCAB_SIZE = 512;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % VOCAB_SIZE;
}

/** Lightweight bag-of-hashed-words embedding for in-memory semantic similarity (no API latency). */
export function buildTitleEmbedding(text: string): Float32Array {
  const vec = new Float32Array(VOCAB_SIZE);
  const tokens = expandQueryTokens(text);
  for (const token of tokens) {
    const idx = hashToken(token);
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const vendorTokens = normalizeBookTitleForSearch(text).split(/\s+/);
  for (const token of vendorTokens) {
    if (token.length < 3) continue;
    const idx = hashToken(`v:${token}`);
    vec[idx] = (vec[idx] ?? 0) + 0.5;
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/** Author / vendor bag-of-words embedding (precomputed on index build). */
export function buildAuthorEmbedding(author: string): Float32Array {
  const normalized = normalizeBookTitleForSearch(author);
  if (!normalized) return new Float32Array(VOCAB_SIZE);
  return buildTitleEmbedding(`author:${normalized}`);
}

/** Product type / tags category embedding. */
export function buildCategoryEmbedding(productType: string | null, tags: string | null): Float32Array {
  const combined = [productType ?? '', tags ?? ''].filter(Boolean).join(' ');
  if (!combined.trim()) return new Float32Array(VOCAB_SIZE);
  return buildTitleEmbedding(`category:${combined}`);
}

/** Strip HTML and embed description + tags for semantic recovery. */
export function buildDescriptionEmbedding(bodyHtml: string | null, tags: string | null): Float32Array {
  const plain = (bodyHtml ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  const combined = [plain, tags ?? ''].filter(Boolean).join(' ');
  if (!combined.trim()) return new Float32Array(VOCAB_SIZE);
  return buildTitleEmbedding(`desc:${combined}`);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return Math.max(0, Math.min(1, dot));
}
