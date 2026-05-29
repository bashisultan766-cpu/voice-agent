import type { BookstoreConfidenceTier } from '../types/bookstore-search.types';

export function buildPremiumSearchVoiceSummary(input: {
  queryDisplay: string;
  primaryTitle: string;
  primaryVendor?: string | null;
  confidenceTier: BookstoreConfidenceTier;
  similarAlternatives?: Array<{ title: string; vendor?: string | null }>;
  exactMatchFound: boolean;
  priceLine?: string;
}): string {
  const { queryDisplay, primaryTitle, primaryVendor, confidenceTier, similarAlternatives, exactMatchFound, priceLine } =
    input;

  if (confidenceTier === 'LOW') {
    return `I want to make sure I find the correct book for you. Let me check similar titles and editions${
      queryDisplay ? ` for "${queryDisplay}"` : ''
    }.`;
  }

  if (!exactMatchFound && similarAlternatives?.length) {
    const alt = similarAlternatives[0]!;
    const by = alt.vendor ? ` by ${alt.vendor}` : primaryVendor ? ` by ${primaryVendor}` : '';
    const lead = `I couldn't find the exact edition yet, but I found similar books you may like. The closest is ${alt.title}${by}. Would you like me to check that one?`;
    if (similarAlternatives.length > 1) {
      const also = similarAlternatives
        .slice(1, 3)
        .map((b) => b.title)
        .join(', and ');
      return `${lead} I also have similar titles like ${also}.`;
    }
    return lead;
  }

  if (confidenceTier === 'MEDIUM') {
    const by = primaryVendor ? ` by ${primaryVendor}` : '';
    return `I found ${primaryTitle}${by}, which might be what you meant for ${queryDisplay}. Is that the one you want?${priceLine ? ` ${priceLine}` : ''}`;
  }

  const by = primaryVendor ? ` by ${primaryVendor}` : '';
  return `I found ${primaryTitle}${by}.${priceLine ? ` ${priceLine}` : ''}`;
}

export function buildSimilarBooksVoiceLead(count: number): string {
  if (count <= 0) {
    return `I couldn't find the exact edition yet, but I'm checking similar titles and authors.`;
  }
  return `I couldn't find the exact edition yet, but I found similar books you may like.`;
}
