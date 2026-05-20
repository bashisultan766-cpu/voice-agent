import { Prisma } from '@prisma/client';
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
export declare class OrderBookingService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    private ensureDraft;
    startBooking(callSessionId: string, tenantId: string, agentId: string, items: BookingItemInput[]): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    }>;
    setCustomerDetails(callSessionId: string, tenantId: string, agentId: string, customer: CustomerDetailsInput): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    }>;
    setDeliveryDetails(callSessionId: string, tenantId: string, agentId: string, address: DeliveryDetailsInput): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    }>;
    confirmOrderSummary(callSessionId: string, tenantId: string, agentId: string, confirmed: boolean): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    }>;
    attachCheckoutLink(callSessionId: string, checkoutUrl: string, channel: 'sms' | 'email', destination: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    }>;
    getDraft(callSessionId: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        agentId: string;
        callSessionId: string;
        itemsJson: Prisma.JsonValue | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        checkoutUrl: string | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
        completedAt: Date | null;
    } | null>;
}
export {};
