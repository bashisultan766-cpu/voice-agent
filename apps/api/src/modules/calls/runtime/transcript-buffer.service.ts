import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Appends transcript chunks to CallTranscript.
 * Step 5 skeleton — called from voice runtime when user/agent speak.
 */
@Injectable()
export class TranscriptBufferService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Prior user/assistant turns for OpenAI chat history (excludes system/tool rows).
   * Most recent `maxMessages` rows in chronological order.
   */
  async getConversationHistory(
    callSessionId: string,
    maxMessages = 24,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const rows = await this.prisma.callTranscript.findMany({
      where: { callSessionId, role: { in: ['user', 'agent'] } },
      orderBy: { sequenceNumber: 'desc' },
      take: maxMessages,
      select: { role: true, content: true },
    });
    const chronological = rows.reverse();
    return chronological.map((r) => ({
      role: r.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: r.content,
    }));
  }

  async append(
    callSessionId: string,
    role: 'user' | 'agent' | 'system' | 'tool',
    content: string,
    sequenceNumber: number,
    timestampMs?: number,
  ) {
    await this.prisma.callTranscript.create({
      data: {
        callSessionId,
        role,
        content,
        sequenceNumber,
        timestampMs: timestampMs ?? undefined,
      },
    });
  }

  async getNextSequence(callSessionId: string): Promise<number> {
    const last = await this.prisma.callTranscript.findFirst({
      where: { callSessionId },
      orderBy: { sequenceNumber: 'desc' },
      select: { sequenceNumber: true },
    });
    return (last?.sequenceNumber ?? 0) + 1;
  }
}
