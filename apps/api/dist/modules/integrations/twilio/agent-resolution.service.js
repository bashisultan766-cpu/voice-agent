"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AgentResolutionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentResolutionService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const normalize_phone_1 = require("./utils/normalize-phone");
const client_1 = require("@prisma/client");
function inboundVoiceAgentStatuses() {
    const allowDraft = process.env.VOICE_ALLOW_DRAFT_AGENTS === 'true' ||
        process.env.ALLOW_DRAFT_VOICE_AGENTS === 'true' ||
        process.env.NODE_ENV !== 'production';
    return allowDraft
        ? [client_1.AgentStatus.ACTIVE, client_1.AgentStatus.READY, client_1.AgentStatus.DRAFT]
        : [client_1.AgentStatus.ACTIVE, client_1.AgentStatus.READY];
}
function digitsLast4(value) {
    const d = value.replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : '****';
}
let AgentResolutionService = AgentResolutionService_1 = class AgentResolutionService {
    constructor(prisma) {
        this.prisma = prisma;
        this.log = new common_1.Logger(AgentResolutionService_1.name);
    }
    hasAmbiguousTenantAssignment(rows) {
        if (rows.length < 2)
            return false;
        const tenants = new Set(rows.map((row) => row.agent.tenantId));
        return tenants.size > 1;
    }
    async resolveByPhoneNumber(toNumber) {
        const normalized = (0, normalize_phone_1.normalizePhoneNumber)(toNumber);
        this.log.log(JSON.stringify({
            event: 'twilio.agent_resolution.lookup',
            toRawLast4: digitsLast4(toNumber),
            normalizedLast4: digitsLast4(normalized),
        }));
        const mappings = await this.prisma.phoneNumberMapping.findMany({
            where: {
                phoneNumber: normalized,
                agent: {
                    deletedAt: null,
                    status: { in: inboundVoiceAgentStatuses() },
                },
            },
            include: {
                phoneNumberRef: true,
                agent: {
                    include: {
                        store: true,
                    },
                },
            },
            orderBy: [{ isPrimaryInbound: 'desc' }, { updatedAt: 'desc' }],
            take: 2,
        });
        if (this.hasAmbiguousTenantAssignment(mappings)) {
            return null;
        }
        const mapping = mappings[0] ?? null;
        if (mapping?.agent) {
            this.log.log(JSON.stringify({
                event: 'twilio.agent_resolution.via_mapping',
                normalizedLast4: digitsLast4(normalized),
                tenantId: mapping.agent.tenantId,
                agentId: mapping.agent.id,
                mappingFound: true,
            }));
            const agent = mapping.agent;
            const store = agent.store;
            return {
                tenantId: agent.tenantId,
                storeId: agent.storeId,
                agentId: agent.id,
                phoneNumberId: mapping.phoneNumberRef?.id ?? mapping.phoneNumberId ?? null,
                agent: {
                    name: agent.name,
                    voice: agent.voice,
                    voiceProvider: agent.voiceProvider,
                    voiceId: agent.voiceId,
                    language: agent.language,
                    baseSystemPrompt: agent.baseSystemPrompt,
                    greetingMessage: agent.greetingMessage,
                    fallbackMessage: agent.fallbackMessage,
                    escalationMessage: agent.escalationMessage,
                    model: agent.model,
                    temperature: agent.temperature,
                },
                store: store
                    ? { name: store.name, city: store.city, timezone: store.timezone }
                    : { name: agent.storeName ?? 'Store', city: null, timezone: agent.timezone ?? null },
            };
        }
        const phones = await this.prisma.phoneNumber.findMany({
            where: {
                phoneNumber: normalized,
                status: 'ACTIVE',
                agentId: { not: null },
                agent: {
                    deletedAt: null,
                    status: { in: inboundVoiceAgentStatuses() },
                },
            },
            include: {
                agent: {
                    include: {
                        store: true,
                    },
                },
            },
            take: 2,
        });
        const phone = phones[0] ?? null;
        if (phones.length > 1 && phones[1]?.tenantId !== phone?.tenantId) {
            return null;
        }
        if (phone?.agent) {
            this.log.log(JSON.stringify({
                event: 'twilio.agent_resolution.via_phone_table',
                normalizedLast4: digitsLast4(normalized),
                tenantId: phone.agent.tenantId,
                agentId: phone.agent.id,
            }));
            const agent = phone.agent;
            const store = agent.store;
            return {
                tenantId: agent.tenantId,
                storeId: agent.storeId,
                agentId: agent.id,
                phoneNumberId: phone.id,
                agent: {
                    name: agent.name,
                    voice: agent.voice,
                    voiceProvider: agent.voiceProvider,
                    voiceId: agent.voiceId,
                    language: agent.language,
                    baseSystemPrompt: agent.baseSystemPrompt,
                    greetingMessage: agent.greetingMessage,
                    fallbackMessage: agent.fallbackMessage,
                    escalationMessage: agent.escalationMessage,
                    model: agent.model,
                    temperature: agent.temperature,
                },
                store: store
                    ? { name: store.name, city: store.city, timezone: store.timezone }
                    : { name: agent.storeName ?? 'Store', city: null, timezone: agent.timezone ?? null },
            };
        }
        const statuses = inboundVoiceAgentStatuses();
        const byField = await this.prisma.agent.findMany({
            where: {
                deletedAt: null,
                status: { in: statuses },
                twilioPhoneNumber: normalized,
            },
            include: { store: true },
            orderBy: { updatedAt: 'desc' },
            take: 5,
        });
        let agent = null;
        if (byField.length > 0) {
            const tenants = new Set(byField.map((a) => a.tenantId));
            if (tenants.size > 1) {
                this.log.warn(JSON.stringify({
                    event: 'twilio.agent_resolution.ambiguous_tenant',
                    normalizedLast4: digitsLast4(normalized),
                    tenantCount: tenants.size,
                }));
                return null;
            }
            agent = byField[0];
        }
        if (!agent) {
            const candidates = await this.prisma.agent.findMany({
                where: {
                    deletedAt: null,
                    status: { in: statuses },
                    twilioPhoneNumber: { not: null },
                },
                include: { store: true },
            });
            const matched = candidates.filter((a) => a.twilioPhoneNumber && (0, normalize_phone_1.normalizePhoneNumber)(a.twilioPhoneNumber) === normalized);
            if (matched.length > 0) {
                const tenants = new Set(matched.map((a) => a.tenantId));
                if (tenants.size > 1) {
                    this.log.warn(JSON.stringify({
                        event: 'twilio.agent_resolution.ambiguous_tenant_normalized',
                        normalizedLast4: digitsLast4(normalized),
                        tenantCount: tenants.size,
                    }));
                    return null;
                }
                agent = matched.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
            }
        }
        if (!agent) {
            const mappingAnyStatus = await this.prisma.phoneNumberMapping.findFirst({
                where: { phoneNumber: normalized },
                include: { agent: { select: { id: true, status: true, tenantId: true, deletedAt: true } } },
            });
            const mappingRowCount = await this.prisma.phoneNumberMapping.count({
                where: { phoneNumber: normalized },
            });
            const mappedAgent = mappingAnyStatus?.agent;
            let hint;
            if (mappedAgent?.deletedAt != null) {
                hint = 'Mapping points to a deleted agent.';
            }
            else if (mappedAgent && !inboundVoiceAgentStatuses().includes(mappedAgent.status)) {
                hint = 'Phone is mapped but agent status is not ACTIVE or READY.';
            }
            else if (mappingRowCount === 0) {
                hint = 'No PhoneNumberMapping for normalized To; save the agent phone number to create the link.';
            }
            this.log.warn(JSON.stringify({
                event: 'twilio.agent_resolution.miss',
                normalizedLast4: digitsLast4(normalized),
                mappingRowCount,
                mappingAgentId: mappingAnyStatus?.agentId ?? null,
                mappingAgentStatus: mappedAgent?.status ?? null,
                mappingAgentDeleted: mappedAgent?.deletedAt != null,
                hint,
            }));
            return null;
        }
        this.log.log(JSON.stringify({
            event: 'twilio.agent_resolution.via_agent_field',
            normalizedLast4: digitsLast4(normalized),
            tenantId: agent.tenantId,
            agentId: agent.id,
        }));
        const store = agent.store;
        return {
            tenantId: agent.tenantId,
            storeId: agent.storeId,
            agentId: agent.id,
            phoneNumberId: null,
            agent: {
                name: agent.name,
                voice: agent.voice,
                voiceProvider: agent.voiceProvider,
                voiceId: agent.voiceId,
                language: agent.language,
                baseSystemPrompt: agent.baseSystemPrompt,
                greetingMessage: agent.greetingMessage,
                fallbackMessage: agent.fallbackMessage,
                escalationMessage: agent.escalationMessage,
                model: agent.model,
                temperature: agent.temperature,
            },
            store: store
                ? { name: store.name, city: store.city, timezone: store.timezone }
                : { name: agent.storeName ?? 'Store', city: null, timezone: agent.timezone ?? null },
        };
    }
};
exports.AgentResolutionService = AgentResolutionService;
exports.AgentResolutionService = AgentResolutionService = AgentResolutionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AgentResolutionService);
//# sourceMappingURL=agent-resolution.service.js.map