-- Optional SQL seed for a Shopify fashion demo store (Postgres).
-- Database should match `VOICE_AGENT_DATABASE_URL` for `packages/voice-db`.

INSERT INTO "store_settings" (
  "id",
  "storeKey",
  "storeName",
  "greeting",
  "timezone",
  "hoursJson",
  "shippingPolicy",
  "returnsPolicy",
  "storePolicyNotes",
  "escalationPhone",
  "createdAt",
  "updatedAt"
) VALUES (
  'seed_store_1',
  'demo-fashion',
  'Northwind Atelier',
  'Thanks for calling Northwind Atelier. How can I help today?',
  'America/New_York',
  '{"monFri":"11 a.m. to 7 p.m. Eastern","sat":"10 a.m. to 6 p.m. Eastern","sun":"Closed"}'::jsonb,
  'Standard shipping is three to five business days within the continental United States. Express is one to two business days when placed before noon Eastern.',
  'Unworn items with tags attached may be returned within thirty days for store credit or exchange. Final sale items cannot be returned.',
  'Price adjustments are not offered on past purchases. Gift cards are non-refundable.',
  '+18005550199',
  NOW(),
  NOW()
)
ON CONFLICT ("storeKey") DO UPDATE SET
  "storeName" = EXCLUDED."storeName",
  "greeting" = EXCLUDED."greeting",
  "updatedAt" = NOW();

DELETE FROM "faq_items" WHERE "storeKey" = 'demo-fashion';

INSERT INTO "faq_items" ("id","storeKey","question","answer","category","priority","isActive","createdAt","updatedAt")
VALUES
  ('seed_faq_1','demo-fashion','Do you ship internationally?','We currently ship to the United States and Canada. Duties and taxes for Canada are calculated at checkout.','shipping',10,true,NOW(),NOW()),
  ('seed_faq_2','demo-fashion','How do I find my size?','Each product page includes a measurement chart. If you are between sizes, we usually recommend sizing up for outerwear.','sizing',9,true,NOW(),NOW()),
  ('seed_faq_3','demo-fashion','Can I change or cancel an order?','Orders process quickly. If you need a change, call us right away with your order number. Once shipped, we cannot modify the order.','orders',8,true,NOW(),NOW());
