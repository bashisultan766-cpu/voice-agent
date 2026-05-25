import { Injectable } from '@nestjs/common';
import { CallResolutionStatus, ToolExecutionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TERMINAL_CALL_STATUSES } from '../../database/prisma.types';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(tenantId: string, from?: Date, to?: Date) {
    const sessionWhere = { tenantId, ...dateRange(from, to) };
    const [totalCalls, outcomes, escalated] = await Promise.all([
      this.prisma.callSession.count({ where: { ...sessionWhere, status: { in: TERMINAL_CALL_STATUSES } } }),
      this.prisma.callOutcome.findMany({
        where: { tenantId, callSession: dateRangeSession(from, to) },
        select: { resolutionStatus: true },
      }),
      this.prisma.callSession.count({ where: { ...sessionWhere, escalated: true } }),
    ]);
    const resolved = outcomes.filter((o) => o.resolutionStatus === CallResolutionStatus.RESOLVED).length;
    const resolutionRate = totalCalls > 0 ? (resolved / totalCalls) * 100 : 0;
    const escalationRate = totalCalls > 0 ? (escalated / totalCalls) * 100 : 0;
    const avgDuration = await this.prisma.callSession.aggregate({
      where: { ...sessionWhere, durationSeconds: { not: null } },
      _avg: { durationSeconds: true },
    });
    const withCallback = await this.prisma.callOutcome.count({
      where: { tenantId, callbackRequested: true, callSession: dateRangeSession(from, to) },
    });
    const outcomeMetrics = await this.prisma.callOutcome.findMany({
      where: { tenantId, callSession: dateRangeSession(from, to) },
      select: { conversionOutcome: true, productsRequested: true },
    });
    const converted = outcomeMetrics.filter((o) =>
      ['payment_link_sent', 'order_completed'].includes(o.conversionOutcome ?? ''),
    ).length;
    const conversionRate = totalCalls > 0 ? (converted / totalCalls) * 100 : 0;

    const productOutcomes = outcomeMetrics;
    const productCounts = new Map<string, number>();
    for (const row of productOutcomes) {
      const list = Array.isArray(row.productsRequested) ? (row.productsRequested as string[]) : [];
      for (const title of list) {
        if (typeof title === 'string' && title.trim()) {
          productCounts.set(title, (productCounts.get(title) ?? 0) + 1);
        }
      }
    }
    const topProductsRequested = Array.from(productCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, count]) => ({ title, count }));

    return {
      totalCalls,
      resolutionRate: Math.round(resolutionRate * 100) / 100,
      escalationRate: Math.round(escalationRate * 100) / 100,
      conversionRate: Math.round(conversionRate * 100) / 100,
      avgDurationSeconds: avgDuration._avg.durationSeconds ?? 0,
      callbackRequestCount: withCallback,
      topProductsRequested,
    };
  }

  async getAgentMetrics(tenantId: string, from?: Date, to?: Date) {
    const sessions = await this.prisma.callSession.findMany({
      where: { tenantId, ...dateRange(from, to), status: { in: TERMINAL_CALL_STATUSES } },
      include: { callOutcome: true, agent: { select: { id: true, name: true } } },
    });
    const sessionIds = sessions.map((s) => s.id);
    const [toolTotals, toolFailures] = await Promise.all([
      this.prisma.toolExecution.groupBy({
        by: ['callSessionId'],
        where: { callSessionId: { in: sessionIds } },
        _count: { _all: true },
      }),
      this.prisma.toolExecution.groupBy({
        by: ['callSessionId'],
        where: { callSessionId: { in: sessionIds }, status: ToolExecutionStatus.FAILED },
        _count: { _all: true },
      }),
    ]);
    const toolTotalBySession = new Map(toolTotals.map((r) => [r.callSessionId ?? '', r._count._all]));
    const toolFailureBySession = new Map(toolFailures.map((r) => [r.callSessionId ?? '', r._count._all]));
    const byAgent = new Map<
      string,
      { agentId: string; agentName: string; total: number; resolved: number; escalated: number; totalDuration: number; totalToolCalls: number; toolFailures: number }
    >();
    for (const s of sessions) {
      const key = s.agentId;
      if (!byAgent.has(key)) {
        byAgent.set(key, {
          agentId: s.agent.id,
          agentName: s.agent.name,
          total: 0,
          resolved: 0,
          escalated: 0,
          totalDuration: 0,
          totalToolCalls: 0,
          toolFailures: 0,
        });
      }
      const row = byAgent.get(key)!;
      row.total += 1;
      if (s.callOutcome?.resolutionStatus === CallResolutionStatus.RESOLVED) row.resolved += 1;
      if (s.escalated) row.escalated += 1;
      row.totalDuration += s.durationSeconds ?? 0;
      const tools = toolTotalBySession.get(s.id) ?? 0;
      const failures = toolFailureBySession.get(s.id) ?? 0;
      row.totalToolCalls += tools;
      row.toolFailures += failures;
    }
    return Array.from(byAgent.values()).map((r) => ({
      ...r,
      resolutionRate: r.total > 0 ? Math.round((r.resolved / r.total) * 10000) / 100 : 0,
      escalationRate: r.total > 0 ? Math.round((r.escalated / r.total) * 10000) / 100 : 0,
      avgDurationSeconds: r.total > 0 ? Math.round((r.totalDuration / r.total) * 100) / 100 : 0,
      avgToolCalls: r.total > 0 ? Math.round((r.totalToolCalls / r.total) * 100) / 100 : 0,
    }));
  }

  async getStoreMetrics(tenantId: string, from?: Date, to?: Date) {
    const sessions = await this.prisma.callSession.findMany({
      where: { tenantId, ...dateRange(from, to), status: { in: TERMINAL_CALL_STATUSES } },
      include: { callOutcome: true, store: { select: { id: true, name: true } } },
    });
    const byStore = new Map<
      string,
      { storeId: string; storeName: string; total: number; resolved: number; escalated: number }
    >();
    for (const s of sessions) {
      const key = s.storeId;
      const store = s.store;
      if (key == null || store == null) continue;
      if (!byStore.has(key)) {
        byStore.set(key, { storeId: store.id, storeName: store.name, total: 0, resolved: 0, escalated: 0 });
      }
      const row = byStore.get(key)!;
      row.total += 1;
      if (s.callOutcome?.resolutionStatus === CallResolutionStatus.RESOLVED) row.resolved += 1;
      if (s.escalated) row.escalated += 1;
    }
    return Array.from(byStore.values()).map((r) => ({
      ...r,
      resolutionRate: r.total > 0 ? Math.round((r.resolved / r.total) * 10000) / 100 : 0,
      escalationRate: r.total > 0 ? Math.round((r.escalated / r.total) * 10000) / 100 : 0,
    }));
  }

  async getToolMetrics(tenantId: string, from?: Date, to?: Date) {
    const executions = await this.prisma.toolExecution.findMany({
      where: {
        tenantId,
        callSessionId: { not: null },
        callSession: dateRangeSession(from, to),
      },
      select: {
        toolName: true,
        status: true,
        latencyMs: true,
      },
    });
    const byTool = new Map<string, { total: number; success: number; failed: number; totalLatency: number }>();
    for (const e of executions) {
      if (!byTool.has(e.toolName)) {
        byTool.set(e.toolName, { total: 0, success: 0, failed: 0, totalLatency: 0 });
      }
      const row = byTool.get(e.toolName)!;
      row.total += 1;
      if (e.status === ToolExecutionStatus.SUCCESS) row.success += 1;
      else row.failed += 1;
      row.totalLatency += e.latencyMs ?? 0;
    }
    return Array.from(byTool.entries()).map(([toolName, r]) => ({
      toolName,
      totalCalls: r.total,
      successCount: r.success,
      failureCount: r.failed,
      successRate: r.total > 0 ? Math.round((r.success / r.total) * 10000) / 100 : 0,
      avgLatencyMs: r.total > 0 ? Math.round(r.totalLatency / r.total) : 0,
    }));
  }
}

function dateRange(from?: Date, to?: Date): { endedAt?: { gte?: Date; lte?: Date } } {
  if (!from && !to) return {};
  return {
    endedAt: {
      ...(from && { gte: from }),
      ...(to && { lte: to }),
    },
  };
}

function dateRangeSession(from?: Date, to?: Date): { endedAt?: { gte?: Date; lte?: Date } } {
  return dateRange(from, to);
}
