import { Injectable } from '@nestjs/common';
import { OrderBookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

interface BookingItemInput {
  productId: string;
  variantId?: string;
  title?: string;
  quantity: number;
}

interface CustomerDetailsInput {
  name: string;
  phone: string;
  email?: string;
}

interface DeliveryDetailsInput {
  addressLine1: string;
  city: string;
  postalCode?: string;
  country?: string;
}

@Injectable()
export class OrderBookingService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureDraft(callSessionId: string, tenantId: string, agentId: string) {
    return this.prisma.orderBookingDraft.upsert({
      where: { callSessionId },
      create: {
        callSessionId,
        tenantId,
        agentId,
      },
      update: {},
    });
  }

  async startBooking(callSessionId: string, tenantId: string, agentId: string, items: BookingItemInput[]) {
    const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
    const normalized = items
      .filter((i) => i.productId?.trim())
      .map((i) => ({
        productId: i.productId.trim(),
        variantId: i.variantId?.trim() || undefined,
        title: i.title?.trim() || undefined,
        quantity: Math.max(1, Number(i.quantity) || 1),
      }));
    return this.prisma.orderBookingDraft.update({
      where: { id: draft.id },
      data: {
        itemsJson: normalized as Prisma.InputJsonValue,
        status: OrderBookingStatus.DRAFT,
      },
    });
  }

  async setCustomerDetails(callSessionId: string, tenantId: string, agentId: string, customer: CustomerDetailsInput) {
    const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
    return this.prisma.orderBookingDraft.update({
      where: { id: draft.id },
      data: {
        customerJson: {
          name: customer.name.trim(),
          phone: customer.phone.trim(),
          email: customer.email?.trim() || undefined,
        } as Prisma.InputJsonValue,
      },
    });
  }

  async setDeliveryDetails(callSessionId: string, tenantId: string, agentId: string, address: DeliveryDetailsInput) {
    const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
    return this.prisma.orderBookingDraft.update({
      where: { id: draft.id },
      data: {
        deliveryAddressJson: {
          addressLine1: address.addressLine1.trim(),
          city: address.city.trim(),
          postalCode: address.postalCode?.trim() || undefined,
          country: address.country?.trim() || undefined,
        } as Prisma.InputJsonValue,
      },
    });
  }

  async confirmOrderSummary(callSessionId: string, tenantId: string, agentId: string, confirmed: boolean) {
    const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
    return this.prisma.orderBookingDraft.update({
      where: { id: draft.id },
      data: confirmed
        ? {
            status: OrderBookingStatus.READY_FOR_PAYMENT,
            confirmedAt: new Date(),
          }
        : {
            status: OrderBookingStatus.DRAFT,
            confirmedAt: null,
          },
    });
  }

  async attachCheckoutLink(
    callSessionId: string,
    checkoutUrl: string,
    channel: 'sms' | 'email',
    destination: string,
  ) {
    return this.prisma.orderBookingDraft.update({
      where: { callSessionId },
      data: {
        status: OrderBookingStatus.CHECKOUT_CREATED,
        checkoutUrl,
        paymentChannel: channel,
        paymentDestination: destination,
      },
    });
  }

  async getDraft(callSessionId: string) {
    return this.prisma.orderBookingDraft.findUnique({
      where: { callSessionId },
    });
  }
}
