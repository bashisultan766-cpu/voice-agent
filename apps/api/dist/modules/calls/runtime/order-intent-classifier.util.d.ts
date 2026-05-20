export type OrderTurnIntent = 'product_search' | 'product_confirmed' | 'variant_selected' | 'quantity_provided' | 'customer_name_provided' | 'email_provided' | 'order_confirmed' | 'cancel_order' | 'general_question';
export type OrderTurnClassification = {
    intent: OrderTurnIntent;
    confidence: number;
    extracted?: {
        email?: string;
        quantity?: number;
        customerName?: string;
    };
    rawText?: string;
};
export declare function classifyOrderTurn(text: string): OrderTurnClassification;
