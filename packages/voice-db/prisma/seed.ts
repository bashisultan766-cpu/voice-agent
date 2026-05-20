import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

async function main() {
  const storeKey = process.env.VOICE_SEED_STORE_KEY || 'demo-fashion';

  await prisma.storeSetting.upsert({
    where: { storeKey },
    create: {
      storeKey,
      storeName: 'Northwind Atelier',
      greeting: 'Thanks for calling Northwind Atelier. How can I help today?',
      timezone: 'America/New_York',
      hoursJson: {
        monFri: '11 a.m. to 7 p.m. Eastern',
        sat: '10 a.m. to 6 p.m. Eastern',
        sun: 'Closed',
      },
      shippingPolicy:
        'Standard shipping is three to five business days within the continental United States. Express is one to two business days when placed before noon Eastern.',
      returnsPolicy:
        'Unworn items with tags attached may be returned within thirty days for store credit or exchange. Final sale items cannot be returned.',
      storePolicyNotes:
        'Price adjustments are not offered on past purchases. Gift cards are non-refundable.',
      escalationPhone: '+18005550199',
    },
    update: {
      storeName: 'Northwind Atelier',
      greeting: 'Thanks for calling Northwind Atelier. How can I help today?',
    },
  });

  const faqs = [
    {
      question: 'Do you ship internationally?',
      answer:
        'We currently ship to the United States and Canada. Duties and taxes for Canada are calculated at checkout.',
      category: 'shipping',
      priority: 10,
    },
    {
      question: 'How do I find my size?',
      answer:
        'Each product page includes a measurement chart. If you are between sizes, we usually recommend sizing up for outerwear.',
      category: 'sizing',
      priority: 9,
    },
    {
      question: 'Can I change or cancel an order?',
      answer:
        'Orders process quickly. If you need a change, call us right away with your order number. Once shipped, we cannot modify the order.',
      category: 'orders',
      priority: 8,
    },
  ];

  for (const f of faqs) {
    const existing = await prisma.faqItem.findFirst({
      where: { storeKey, question: f.question },
    });
    if (!existing) {
      await prisma.faqItem.create({
        data: {
          storeKey,
          question: f.question,
          answer: f.answer,
          category: f.category,
          priority: f.priority,
        },
      });
    }
  }

  // Optional: map Twilio inbound number to this store in production via storeKey = E.164
  console.log('Seed complete for storeKey:', storeKey);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
