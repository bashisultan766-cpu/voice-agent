import 'reflect-metadata';
import { PrismaService } from '../database/prisma.service';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { INestApplicationContext } from '@nestjs/common';

export type DevScriptContext = {
  tenantId: string;
  agentId: string;
  callSessionId?: string;
};

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export async function assertTenantAgentContext(
  prisma: PrismaService,
  tenantId: string,
  agentId: string,
): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!agent) {
    throw new Error('DEV_TENANT_ID / DEV_AGENT_ID do not map to a live agent in this database.');
  }
}

export async function withDevAppContext<T>(
  fn: (app: INestApplicationContext) => Promise<T>,
): Promise<T> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

