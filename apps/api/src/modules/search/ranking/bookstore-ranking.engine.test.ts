import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankBookstoreProducts } from './bookstore-ranking.engine';
import type { RankableCatalogProduct } from '../../agents/shopify-product-relevance.util';

function book(title: string, vendor?: string): RankableCatalogProduct & { productId: string } {
  return {
    productId: title.replace(/\s/g, '-'),
    title,
    vendor: vendor ?? null,
    handle: null,
    productType: 'Book',
    tags: [],
    isbn: null,
    variants: [{ sku: null, isbn: null, barcode: null }],
  };
}

test('Dark Tower partial query ranks Gunslinger highly', () => {
  const products = [
    book('The Dark Tower I: The Gunslinger', 'Stephen King'),
    book('Atomic Habits', 'James Clear'),
    book('It: A Novel', 'Stephen King'),
  ];
  const result = rankBookstoreProducts({
    queryOriginal: 'Dark Tower',
    probableTitle: 'Dark Tower',
    products,
    maxResults: 3,
  });
  assert.ok(result.ranked.length >= 1);
  assert.match(result.ranked[0]!.title, /Gunslinger/i);
  assert.ok(result.bestScore >= 650);
});

test('Harry Potter one maps to first book in series', () => {
  const products = [
    book("Harry Potter and the Sorcerer's Stone", 'J.K. Rowling'),
    book('Harry Potter and the Chamber of Secrets', 'J.K. Rowling'),
    book('Rich Dad Poor Dad', 'Robert Kiyosaki'),
  ];
  const result = rankBookstoreProducts({
    queryOriginal: 'Harry Potter one',
    probableTitle: 'Harry Potter one',
    products,
    maxResults: 2,
  });
  assert.ok(result.ranked.length >= 1);
  assert.match(result.ranked[0]!.title, /Sorcerer|Philosopher/i);
});

test('confidence tier HIGH for strong title match', () => {
  const products = [book('Atomic Habits', 'James Clear')];
  const result = rankBookstoreProducts({
    queryOriginal: 'Atomic Habits',
    probableTitle: 'Atomic Habits',
    products,
    maxResults: 1,
  });
  assert.equal(result.confidenceTier, 'HIGH');
});
