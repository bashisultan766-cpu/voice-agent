import { z } from 'zod';

export const simulateToolBodySchema = z.object({
  toolName: z.string().trim().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional(),
  callSessionId: z.string().trim().min(20).max(32).optional(),
});

export const testEmailBodySchema = z.object({
  toEmail: z.string().email().max(320),
  checkoutUrl: z.string().url().max(2048).optional(),
});

export const simulateBuyingFlowBodySchema = z.object({
  query: z.string().trim().min(1).max(160).optional(),
  customerEmail: z.string().email().max(320).optional(),
  sendEmail: z.boolean().optional(),
  checkoutMode: z.enum(['STOREFRONT_CART', 'DRAFT_ORDER_INVOICE']).optional(),
  callSessionId: z.string().trim().min(20).max(32).optional(),
});

export const fullReadinessSmokeBodySchema = z.object({
  query: z.string().trim().min(1).max(160).optional(),
  customerEmail: z.string().email().max(320).optional(),
  runFlowSimulation: z.boolean().optional(),
  sendEmail: z.boolean().optional(),
  checkoutMode: z.enum(['STOREFRONT_CART', 'DRAFT_ORDER_INVOICE']).optional(),
  callSessionId: z.string().trim().min(20).max(32).optional(),
});

/** Prisma cuid() ids start with "c" and are 25 chars. */
export const cuidParamSchema = z
  .string()
  .trim()
  .min(20)
  .max(32)
  .regex(/^c[a-z0-9]+$/i, 'Invalid id');
