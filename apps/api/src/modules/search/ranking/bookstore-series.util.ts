import { extractVolumeNumber, normalizeBookTitleForSearch } from './bookstore-title-normalizer.util';

/** Strip volume/roman suffixes to group series (e.g. "dark tower" from "dark tower i the gunslinger"). */
export function deriveSeriesKey(title: string): string | null {
  const norm = normalizeBookTitleForSearch(title);
  if (!norm) return null;
  const stripped = norm
    .replace(/\b(book|volume|vol|part)\s*\d+\b/g, ' ')
    .replace(/\b(i{1,3}|iv|vi{0,3}|ix|x{1,2})\b/g, ' ')
    .replace(/\b(the gunslinger|sorcerer'?s stone|chamber of secrets)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = stripped.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 2) return words[0] ?? null;
  return words.slice(0, Math.min(4, words.length)).join(' ');
}

export function seriesMatchBoost(
  querySeries: string | null,
  productSeries: string | null,
  queryVolume: number | null,
  productVolume: number | null,
): number {
  if (!querySeries || !productSeries) return 0;
  const q = querySeries.toLowerCase();
  const p = productSeries.toLowerCase();
  if (q === p) {
    if (queryVolume != null && productVolume != null) {
      return queryVolume === productVolume ? 120 : Math.max(0, 80 - Math.abs(queryVolume - productVolume) * 15);
    }
    return 90;
  }
  if (p.includes(q) || q.includes(p)) return 60;
  return 0;
}

export { extractVolumeNumber };
