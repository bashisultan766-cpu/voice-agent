import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookstoreIndexProduct } from '../types/bookstore-search.types';
import { buildAuthorEmbedding, buildCategoryEmbedding, buildDescriptionEmbedding, buildTitleEmbedding } from './bookstore-semantic.util';
import { deriveSeriesKey, extractVolumeNumber } from './bookstore-series.util';
import { normalizeBookTitleForSearch } from './bookstore-title-normalizer.util';
import { retrieveFromCatalogIndex } from './bookstore-catalog-retrieval.util';

function indexBook(title: string, vendor = 'Jack Canfield'): BookstoreIndexProduct {
  const vendorStr = vendor;
  return {
    productId: title.replace(/\s/g, '-').toLowerCase(),
    title,
    handle: null,
    vendor: vendorStr,
    productType: 'Book',
    tags: 'self-help,inspirational',
    normalizedTitle: normalizeBookTitleForSearch(title),
    normalizedAuthor: normalizeBookTitleForSearch(vendorStr),
    seriesKey: deriveSeriesKey(title),
    volumeNumber: extractVolumeNumber(title),
    embedding: buildTitleEmbedding(title),
    authorEmbedding: buildAuthorEmbedding(vendorStr),
    categoryEmbedding: buildCategoryEmbedding('Book', 'self-help,inspirational'),
    descriptionEmbedding: buildDescriptionEmbedding(
      `<p>Inspirational stories for ${title}</p>`,
      'self-help,inspirational',
    ),
    descriptionSnippet: title,
  };
}

test('Kitchen Soap misheard title recovers Chicken Soup via semantic/fuzzy catalog', () => {
  const index = [
    indexBook("Chicken Soup for the Prisoner's Soul", 'Jack Canfield'),
    indexBook('Atomic Habits', 'James Clear'),
    indexBook('The 7 Habits of Highly Effective People', 'Stephen Covey'),
  ];
  const result = retrieveFromCatalogIndex(
    index,
    "Kitchen Soap for the Prisoner's Soul",
    "Kitchen Soap for the Prisoner's Soul",
    5,
  );
  assert.ok(result.candidates.length >= 1, 'expected at least one catalog candidate');
  assert.match(result.candidates[0]!.title, /Chicken Soup/i);
  assert.ok(result.semanticSearchActivated || result.candidates[0]!.rerankScore >= 180);
});

test('partial title song of ice finds Song of Ice and Fire', () => {
  const index = [
    indexBook('A Game of Thrones (A Song of Ice and Fire, Book 1)', 'George R.R. Martin'),
    indexBook('A Clash of Kings (A Song of Ice and Fire, Book 2)', 'George R.R. Martin'),
    indexBook('Dune', 'Frank Herbert'),
  ];
  const result = retrieveFromCatalogIndex(index, 'song of ice', 'song of ice', 5);
  assert.ok(result.candidates.length >= 1);
  assert.match(result.candidates[0]!.title, /Song of Ice|Game of Thrones/i);
});

test('author-only query surfaces books by that author', () => {
  const index = [
    indexBook('It', 'Stephen King'),
    indexBook('The Shining', 'Stephen King'),
    indexBook('Atomic Habits', 'James Clear'),
  ];
  const result = retrieveFromCatalogIndex(index, 'books by Stephen King', 'Stephen King', 5);
  const titles = result.candidates.map((c) => c.title);
  assert.ok(titles.some((t) => /King/i.test(t) || /It|Shining/i.test(t)));
});

test('typo partial dark tower ranks Gunslinger', () => {
  const index = [
    indexBook('The Dark Tower I: The Gunslinger', 'Stephen King'),
    indexBook('Atomic Habits', 'James Clear'),
  ];
  const result = retrieveFromCatalogIndex(index, 'dark towne gunslingr', 'dark tower gunslinger', 5);
  assert.ok(result.candidates.length >= 1);
  assert.match(result.candidates[0]!.title, /Gunslinger|Dark Tower/i);
});
