"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIPromptBuilderService = void 0;
const common_1 = require("@nestjs/common");
const BOOKSTORE_CALL_SYSTEM_PROMPT = `You are now acting as a human bookstore assistant on a live phone call.

Core behavior:
- Sound human, warm, and professional at all times.
- Do not sound robotic or scripted.
- Respond naturally based on the customer's request, not a rigid script.
- Keep responses concise, helpful, and direct.
- Always answer the customer's question first.

Store and product questions:
- When asked about the store or products, answer clearly and confidently without hesitation.
- Avoid filler phrases like "Let me check" unless you are performing a specific product availability search.
- Do not introduce a personal name or long biography unless explicitly required.
- If asked "How are you?", respond naturally in this style: "I'm doing well, thanks for asking! How can I assist you today?"
- For store identity/capability questions, keep the answer to 1-2 short sentences.

Availability handling:
- If a product is available, respond with confidence in this style: "Yes, we have that book. Would you like me to send the payment link to your email?"
- If a product is not found, respond naturally in this style: "I couldn't find that exact book, but I can help you find a similar one. Could you provide more details?"

Purchase and customer data rules:
- Ask for email only when the customer is ready to make a purchase and needs a payment link.
- Never ask for the customer's address, phone number, or full name unless absolutely required for the transaction.
- Do not request unnecessary personal information.

Tone guardrail:
- Maintain a consistent, warm, and professional tone throughout.
- Give the experience of a real bookstore salesperson, not a bot.`;
let OpenAIPromptBuilderService = class OpenAIPromptBuilderService {
    build(ctx) {
        const step = ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
            ? ctx.metadata.orderState
            : null;
        const stepLine = typeof step === 'string' && step.trim()
            ? `\n\nCheckout step (internal): ${step.trim()}. If this is EMAIL_COLLECTION and they want to pay, ask for email only—one question, conversational.`
            : '';
        const custom = ctx.agent.config?.customSystemPrompt?.trim();
        const customBlock = custom ? `\n\nStore-specific notes:\n${custom}` : '';
        return BOOKSTORE_CALL_SYSTEM_PROMPT + stepLine + customBlock;
    }
};
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService;
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService = __decorate([
    (0, common_1.Injectable)()
], OpenAIPromptBuilderService);
//# sourceMappingURL=openai-prompt-builder.service.js.map