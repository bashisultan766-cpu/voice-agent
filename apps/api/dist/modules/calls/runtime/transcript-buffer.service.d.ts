import { PrismaService } from '../../../database/prisma.service';
export declare class TranscriptBufferService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    getConversationHistory(callSessionId: string, maxMessages?: number): Promise<Array<{
        role: 'user' | 'assistant';
        content: string;
    }>>;
    append(callSessionId: string, role: 'user' | 'agent' | 'system' | 'tool', content: string, sequenceNumber: number, timestampMs?: number): Promise<void>;
    getNextSequence(callSessionId: string): Promise<number>;
}
