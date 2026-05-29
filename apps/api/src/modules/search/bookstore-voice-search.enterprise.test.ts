import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankBookstoreProducts } from './ranking/bookstore-ranking.engine';
import { buildPremiumSearchVoiceSummary, buildSimilarBooksVoiceLead } from './voice/bookstore-voice-copy.util';
import type { RankableCatalogProduct } from '../agents/shopify-product-relevance.util';

function book(title: string, vendor?: string, id?: string): RankableCatalogProduct & { productId: string } {
  return {
    productId: id ?? title.replace(/\s/g, '-'),
    title,
    vendor: vendor ?? null,
    handle: null,
    productType: 'Book',
    tags: [],
    isbn: null,
    variants: [{ sku: null, isbn: null, barcode: null }],
  };
}

test('catalog recovery ranking activates semantic for misheard title candidates', () => {
  const products = [
    book("Chicken Soup for the Prisoner's Soul", 'Jack Canfield', 'chicken-soup'),
  ];
  const result = rankBookstoreProducts({
    queryOriginal: "Kitchen Soap for the Prisoner's Soul",
    probableTitle: "Kitchen Soap for the Prisoner's Soul",
    products,
    maxResults: 3,
    catalogSemanticRecovery: true,
  });
  assert.ok(result.semanticSearchActivated);
  assert.ok(result.ranked.length >= 1);
  assert.match(result.ranked[0]!.title, /Chicken Soup/i);
});

test('premium voice copy never asks to repeat title on LOW tier', () => {
  const msg = buildPremiumSearchVoiceSummary({
    queryDisplay: 'Kitchen Soap',
    primaryTitle: '',
    confidenceTier: 'LOW',
    exactMatchFound: false,
  });
  assert.doesNotMatch(msg, /repeat the (book )?title/i);
  assert.match(msg, /similar titles/i);
});

test('similar books lead uses enterprise recovery phrasing', () => {
  const withHits = buildSimilarBooksVoiceLead(2);
  assert.match(withHits, /exact edition yet/i);
  assert.match(withHits, /similar books you may like/i);
  const empty = buildSimilarBooksVoiceLead(0);
  assert.doesNotMatch(empty, /repeat/i);
});

test('semantic recovery returns similar pool when exact match weak', () => {
  const products = [
    book("Chicken Soup for the Prisoner's Soul", 'Jack Canfield'),
    book('Chicken Soup for the Teenage Soul', 'Jack Canfield'),
    book('Atomic Habits', 'James Clear'),
  ];
  const result = rankBookstoreProducts({
    queryOriginal: 'prisoner soul inspirational',
    probableTitle: 'prisoner soul',
    products,
    maxResults: 3,
    catalogSemanticRecovery: true,
  });
  assert.ok(result.ranked.length >= 1);
  assert.ok(result.semanticConfidence > 0 || result.bestScore >= 400);
});
