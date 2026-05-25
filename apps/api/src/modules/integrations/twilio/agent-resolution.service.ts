import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { normalizePhoneNumber } from './utils/normalize-phone';
import { AgentStatus } from '@prisma/client';

function inboundVoiceAgentStatuses(): AgentStatus[] {
  const allowDraft =
    process.env.VOICE_ALLOW_DRAFT_AGENTS === 'true' ||
    process.env.ALLOW_DRAFT_VOICE_AGENTS === 'true' ||
    process.env.NODE_ENV !== 'production';
  return allowDraft
    ? [AgentStatus.ACTIVE, AgentStatus.READY, AgentStatus.DRAFT]
    : [AgentStatus.ACTIVE, AgentStatus.READY];
}

function digitsLast4(value: string): string {
  const d = value.replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '****';
}

export interface ResolvedAgentContext {
  tenantId: string;
  storeId: string | null;
  agentId: string;
  phoneNumberId: string | null;
  agent: {
    name: string;
    voice?: string | null;
    voiceProvider?: string | null;
    voiceId?: string | null;
    language: string;
    baseSystemPrompt: string;
    greetingMessage?: string | null;
    fallbackMessage?: string | null;
    escalationMessage?: string | null;
    model?: string | null;
    temperature?: number | null;
  };
  store: {
    name: string;
    city?: string | null;
    timezone?: string | null;
  };
}

@Injectable()
export class AgentResolutionService {
  private readonly log = new Logger(AgentResolutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hasAmbiguousTenantAssignment<T extends { agent: { tenantId: string } }>(rows: T[]): boolean {
    if (rows.length < 2) return false;
    const tenants = new Set(rows.map((row) => row.agent.tenantId));
    return tenants.size > 1;
  }

  /**
   * Resolve agent (and tenant/store) by incoming destination phone number.
   * 1) Tries PhoneNumber table (number linked to agent + store).
   * 2) Else finds Agent by agent.twilioPhoneNumber matching To (so agents work without PhoneNumber record).
   * Returns null if number not found or agent inactive.
   */
  async resolveByPhoneNumber(toNumber: string): Promise<ResolvedAgentContext | null> {
    const normalized = normalizePhoneNumber(toNumber);
    this.log.log(
      JSON.stringify({
        event: 'twilio.agent_resolution.lookup',
        toRawLast4: digitsLast4(toNumber),
        normalizedLast4: digitsLast4(normalized),
      }),
    );

    // 0) Preferred resolution path in multi-agent mode: PhoneNumberMapping.
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
      this.log.log(
        JSON.stringify({
          event: 'twilio.agent_resolution.via_mapping',
          normalizedLast4: digitsLast4(normalized),
          tenantId: mapping.agent.tenantId,
          agentId: mapping.agent.id,
          mappingFound: true,
        }),
      );
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

    // 1) Resolution via PhoneNumber table (agent has linked Store and PhoneNumber)
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
      this.log.log(
        JSON.stringify({
          event: 'twilio.agent_resolution.via_phone_table',
          normalizedLast4: digitsLast4(normalized),
          tenantId: phone.agent.tenantId,
          agentId: phone.agent.id,
        }),
      );
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

    // 2) Resolution by agent.twilioPhoneNumber (no PhoneNumber record required)
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
    let agent: (typeof byField)[0] | null = null;
    if (byField.length > 0) {
      const tenants = new Set(byField.map((a) => a.tenantId));
      if (tenants.size > 1) {
        this.log.warn(
          JSON.stringify({
            event: 'twilio.agent_resolution.ambiguous_tenant',
            normalizedLast4: digitsLast4(normalized),
            tenantCount: tenants.size,
          }),
        );
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
      const matched = candidates.filter(
        (a) => a.twilioPhoneNumber && normalizePhoneNumber(a.twilioPhoneNumber) === normalized,
      );
      if (matched.length > 0) {
        const tenants = new Set(matched.map((a) => a.tenantId));
        if (tenants.size > 1) {
          this.log.warn(
            JSON.stringify({
              event: 'twilio.agent_resolution.ambiguous_tenant_normalized',
              normalizedLast4: digitsLast4(normalized),
              tenantCount: tenants.size,
            }),
          );
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
      let hint: string | undefined;
      if (mappedAgent?.deletedAt != null) {
        hint = 'Mapping points to a deleted agent.';
      } else if (mappedAgent && !inboundVoiceAgentStatuses().includes(mappedAgent.status)) {
        hint = 'Phone is mapped but agent status is not ACTIVE or READY.';
      } else if (mappingRowCount === 0) {
        hint = 'No PhoneNumberMapping for normalized To; save the agent phone number to create the link.';
      }
      this.log.warn(
        JSON.stringify({
          event: 'twilio.agent_resolution.miss',
          normalizedLast4: digitsLast4(normalized),
          mappingRowCount,
          mappingAgentId: mappingAnyStatus?.agentId ?? null,
          mappingAgentStatus: mappedAgent?.status ?? null,
          mappingAgentDeleted: mappedAgent?.deletedAt != null,
          hint,
        }),
      );
      return null;
    }

    this.log.log(
      JSON.stringify({
        event: 'twilio.agent_resolution.via_agent_field',
        normalizedLast4: digitsLast4(normalized),
        tenantId: agent.tenantId,
        agentId: agent.id,
      }),
    );

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
}
