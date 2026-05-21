import { Prisma } from '@bookstore-voice-agents/voice-db';

/** True when Prisma reports a unique constraint violation (P2002). */
export function isPrismaUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function prismaConflictMessage(err: Prisma.PrismaClientKnownRequestError): string {
  const target = err.meta?.target;
  if (Array.isArray(target) && target.length > 0) {
    return `A record with this ${target.join(', ')} already exists.`;
  }
  return 'A record with these values already exists.';
}
