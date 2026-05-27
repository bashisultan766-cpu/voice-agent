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
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    }>;
    setCustomerDetails(callSessionId: string, tenantId: string, agentId: string, customer: CustomerDetailsInput): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    }>;
    setDeliveryDetails(callSessionId: string, tenantId: string, agentId: string, address: DeliveryDetailsInput): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    }>;
    confirmOrderSummary(callSessionId: string, tenantId: string, agentId: string, confirmed: boolean): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    }>;
    attachCheckoutLink(callSessionId: string, checkoutUrl: string, channel: 'sms' | 'email', destination: string): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    }>;
    getDraft(callSessionId: string): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.OrderBookingStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string;
        checkoutUrl: string | null;
        itemsJson: Prisma.JsonValue | null;
        completedAt: Date | null;
        customerJson: Prisma.JsonValue | null;
        deliveryAddressJson: Prisma.JsonValue | null;
        paymentChannel: string | null;
        paymentDestination: string | null;
        confirmedAt: Date | null;
    } | null>;
}
export {};
