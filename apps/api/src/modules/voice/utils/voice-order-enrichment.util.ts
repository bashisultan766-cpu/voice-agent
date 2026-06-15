import { findCatalogInventoryOverride } from '../data/voice-catalog-overrides.data';
import type { ExtendedOrderLineItem, ExtendedOrderSnapshot } from '../services/voice-order-lookup.service';
import { resolveInventoryStatus } from './voice-inventory-status.util';
import { normalizeShippingMethod } from '../services/voice-shipping.service';
import { SUBTOTAL_DISCLAIMER, sanitizeCustomerFacingText } from './voice-agent-language.util';
import { partitionCustomerFacingLineItems } from './sanitize-voice-commerce-response.util';

export type OrderItemStatus = {
  title: string;
  sku: string | null;
  quantity: number;
  status: 'in_stock' | 'out_of_stock' | 'backorder' | 'unknown';
  reason: string;
};

export function classifyOrderLineItems(
  items: ExtendedOrderLineItem[],
  order: ExtendedOrderSnapshot,
): {
  backorder_items: OrderItemStatus[];
  out_of_stock_items: OrderItemStatus[];
} {
  const backorder: OrderItemStatus[] = [];
  const outOfStock: OrderItemStatus[] = [];
  const customerFacingItems = partitionCustomerFacingLineItems(items).customerFacing;

  for (const line of customerFacingItems) {
    const override = findCatalogInventoryOverride(line.title);
    const note = order.note?.toLowerCase() ?? '';
    const isBackorderNote = note.includes('backorder') || note.includes('back order');

    if (override?.status === 'out_of_stock') {
      outOfStock.push({
        title: line.title,
        sku: line.sku,
        quantity: line.quantity,
        status: 'out_of_stock',
        reason: override.reason ?? 'Currently not in stock.',
      });
      continue;
    }

    if (
      line.unfulfilledQuantity > 0 &&
      line.fulfillableQuantity === 0 &&
      (order.fulfillmentStatus?.toUpperCase() !== 'FULFILLED' || isBackorderNote)
    ) {
      backorder.push({
        title: line.title,
        sku: line.sku,
        quantity: line.unfulfilledQuantity || line.quantity,
        status: 'backorder',
        reason: 'This item is currently on backorder.',
      });
      continue;
    }

    const invStatus = resolveInventoryStatus({ inventory: null });
    if (invStatus === 'out_of_stock') {
      outOfStock.push({
        title: line.title,
        sku: line.sku,
        quantity: line.quantity,
        status: 'out_of_stock',
        reason: 'Currently not in stock.',
      });
    }
  }

  return { backorder_items: backorder, out_of_stock_items: outOfStock };
}

export function buildEnrichedOrderVoiceSummary(args: {
  order: ExtendedOrderSnapshot;
  backorderItems: OrderItemStatus[];
  outOfStockItems: OrderItemStatus[];
  cancellationEligible: boolean;
  shippingMethod: string;
}): string {
  const parts: string[] = [];
  parts.push(`Order ${args.order.orderNumber}.`);
  parts.push(`Status: ${args.order.orderStatus}.`);

  if (args.order.subtotalWithoutShipping) {
    parts.push(
      sanitizeCustomerFacingText(
        `Subtotal before shipping is ${args.order.subtotalWithoutShipping} dollars. ${SUBTOTAL_DISCLAIMER}`,
      ),
    );
  }

  if (args.order.shippingCost && Number(args.order.shippingCost) > 0) {
    parts.push(`Shipping is ${args.order.shippingCost} dollars.`);
  }

  if (args.order.isShipped && args.shippingMethod !== 'Not shipped yet') {
    parts.push(`Shipped via ${args.shippingMethod}.`);
  }

  if (args.backorderItems.length) {
    const titles = args.backorderItems.map((i) => i.title).join(', ');
    parts.push(`The following items are currently on backorder: ${titles}.`);
  }

  if (args.outOfStockItems.length) {
    const titles = args.outOfStockItems.map((i) => i.title).join(', ');
    parts.push(`The following items are currently not in stock: ${titles}.`);
  }

  if (args.cancellationEligible) {
    parts.push('This order may be eligible for cancellation — customer service can process the request.');
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function resolveOrderShippingMethodLabel(order: ExtendedOrderSnapshot): string {
  const tracking = order.fulfillments[0]?.tracking?.[0];
  return normalizeShippingMethod(
    order.shippingMethodTitle,
    tracking?.company ?? order.shippingCarrier,
  );
}
