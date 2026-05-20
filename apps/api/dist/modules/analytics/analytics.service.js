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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyticsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
let AnalyticsService = class AnalyticsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getOverview(tenantId, from, to) {
        const sessionWhere = { tenantId, ...dateRange(from, to) };
        const [totalCalls, outcomes, escalated] = await Promise.all([
            this.prisma.callSession.count({ where: { ...sessionWhere, status: { in: ['COMPLETED', 'FAILED', 'ESCALATED', 'ABANDONED'] } } }),
            this.prisma.callOutcome.findMany({
                where: { tenantId, callSession: dateRangeSession(from, to) },
                select: { resolutionStatus: true },
            }),
            this.prisma.callSession.count({ where: { ...sessionWhere, escalated: true } }),
        ]);
        const resolved = outcomes.filter((o) => o.resolutionStatus === 'RESOLVED').length;
        const resolutionRate = totalCalls > 0 ? (resolved / totalCalls) * 100 : 0;
        const escalationRate = totalCalls > 0 ? (escalated / totalCalls) * 100 : 0;
        const avgDuration = await this.prisma.callSession.aggregate({
            where: { ...sessionWhere, durationSeconds: { not: null } },
            _avg: { durationSeconds: true },
        });
        const withCallback = await this.prisma.callOutcome.count({
            where: { tenantId, callbackRequested: true, callSession: dateRangeSession(from, to) },
        });
        return {
            totalCalls,
            resolutionRate: Math.round(resolutionRate * 100) / 100,
            escalationRate: Math.round(escalationRate * 100) / 100,
            avgDurationSeconds: avgDuration._avg.durationSeconds ?? 0,
            callbackRequestCount: withCallback,
        };
    }
    async getAgentMetrics(tenantId, from, to) {
        const sessions = await this.prisma.callSession.findMany({
            where: { tenantId, ...dateRange(from, to), status: { in: ['COMPLETED', 'FAILED', 'ESCALATED', 'ABANDONED'] } },
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
                where: { callSessionId: { in: sessionIds }, status: 'FAILED' },
                _count: { _all: true },
            }),
        ]);
        const toolTotalBySession = new Map(toolTotals.map((r) => [r.callSessionId ?? '', r._count._all]));
        const toolFailureBySession = new Map(toolFailures.map((r) => [r.callSessionId ?? '', r._count._all]));
        const byAgent = new Map();
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
            const row = byAgent.get(key);
            row.total += 1;
            if (s.callOutcome?.resolutionStatus === 'RESOLVED')
                row.resolved += 1;
            if (s.escalated)
                row.escalated += 1;
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
    async getStoreMetrics(tenantId, from, to) {
        const sessions = await this.prisma.callSession.findMany({
            where: { tenantId, ...dateRange(from, to), status: { in: ['COMPLETED', 'FAILED', 'ESCALATED', 'ABANDONED'] } },
            include: { callOutcome: true, store: { select: { id: true, name: true } } },
        });
        const byStore = new Map();
        for (const s of sessions) {
            const key = s.storeId;
            const store = s.store;
            if (key == null || store == null)
                continue;
            if (!byStore.has(key)) {
                byStore.set(key, { storeId: store.id, storeName: store.name, total: 0, resolved: 0, escalated: 0 });
            }
            const row = byStore.get(key);
            row.total += 1;
            if (s.callOutcome?.resolutionStatus === 'RESOLVED')
                row.resolved += 1;
            if (s.escalated)
                row.escalated += 1;
        }
        return Array.from(byStore.values()).map((r) => ({
            ...r,
            resolutionRate: r.total > 0 ? Math.round((r.resolved / r.total) * 10000) / 100 : 0,
            escalationRate: r.total > 0 ? Math.round((r.escalated / r.total) * 10000) / 100 : 0,
        }));
    }
    async getToolMetrics(tenantId, from, to) {
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
        const byTool = new Map();
        for (const e of executions) {
            if (!byTool.has(e.toolName)) {
                byTool.set(e.toolName, { total: 0, success: 0, failed: 0, totalLatency: 0 });
            }
            const row = byTool.get(e.toolName);
            row.total += 1;
            if (e.status === 'SUCCESS')
                row.success += 1;
            else
                row.failed += 1;
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
};
exports.AnalyticsService = AnalyticsService;
exports.AnalyticsService = AnalyticsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AnalyticsService);
function dateRange(from, to) {
    if (!from && !to)
        return {};
    return {
        endedAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
        },
    };
}
function dateRangeSession(from, to) {
    return dateRange(from, to);
}
//# sourceMappingURL=analytics.service.js.map