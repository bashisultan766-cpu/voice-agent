"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseConnectionTestService = void 0;
const common_1 = require("@nestjs/common");
const node_net_1 = require("node:net");
let DatabaseConnectionTestService = class DatabaseConnectionTestService {
    validateRequired(config) {
        const url = config.databaseUrl?.trim();
        if (!url && !config.databaseAccessToken?.trim()) {
            return 'Database connection URL or access token is required to test the connection.';
        }
        if (url) {
            const valid = url.startsWith('postgresql://') ||
                url.startsWith('postgres://') ||
                url.startsWith('mongodb://') ||
                url.startsWith('mongodb+srv://') ||
                /^https?:\/\//.test(url);
            if (!valid) {
                return 'Please enter a valid database URL (e.g. postgresql://... or mongodb://...).';
            }
        }
        return null;
    }
    async testConnection(config) {
        const validationError = this.validateRequired(config);
        if (validationError) {
            return { success: false, message: validationError };
        }
        const provider = (config.databaseProvider ?? '').trim().toLowerCase();
        const url = config.databaseUrl?.trim();
        const token = config.databaseAccessToken?.trim();
        try {
            if (url) {
                const parsed = new URL(url);
                const scheme = parsed.protocol.replace(':', '').toLowerCase();
                if (scheme === 'http' || scheme === 'https') {
                    const result = await this.probeHttp(parsed, token);
                    if (!result.success)
                        return result;
                    return { success: true, message: 'HTTP database endpoint responded successfully.' };
                }
                if (scheme.startsWith('postgres') || scheme.startsWith('mongodb')) {
                    await this.probeTcp(parsed.hostname, Number(parsed.port) || this.defaultPortForScheme(scheme));
                    return {
                        success: true,
                        message: `Successfully connected to ${scheme} host ${parsed.hostname}:${Number(parsed.port) || this.defaultPortForScheme(scheme)}.`,
                    };
                }
                return {
                    success: false,
                    message: `Unsupported database URL scheme "${scheme}".`,
                };
            }
            if (provider === 'supabase' && token) {
                return {
                    success: true,
                    message: 'Access token provided. Add DATABASE_URL to run an active network connectivity test.',
                };
            }
            return {
                success: false,
                message: 'Provide DATABASE_URL to run a real connectivity test.',
            };
        }
        catch (err) {
            return {
                success: false,
                message: err instanceof Error ? `Database connection failed: ${err.message}` : 'Database connection failed.',
            };
        }
    }
    defaultPortForScheme(scheme) {
        if (scheme.startsWith('postgres'))
            return 5432;
        if (scheme.startsWith('mongodb'))
            return 27017;
        return 443;
    }
    async probeHttp(url, token) {
        const res = await fetch(url.toString(), {
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.status >= 200 && res.status < 500) {
            return { success: true, message: `HTTP endpoint responded with status ${res.status}.` };
        }
        return { success: false, message: `HTTP endpoint returned ${res.status}.` };
    }
    async probeTcp(host, port) {
        await new Promise((resolve, reject) => {
            const socket = new node_net_1.Socket();
            const timeoutMs = 5000;
            const cleanup = () => {
                socket.removeAllListeners();
                socket.destroy();
            };
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => {
                cleanup();
                resolve();
            });
            socket.once('timeout', () => {
                cleanup();
                reject(new Error(`Timed out connecting to ${host}:${port}.`));
            });
            socket.once('error', (err) => {
                cleanup();
                reject(err);
            });
            socket.connect(port, host);
        });
    }
};
exports.DatabaseConnectionTestService = DatabaseConnectionTestService;
exports.DatabaseConnectionTestService = DatabaseConnectionTestService = __decorate([
    (0, common_1.Injectable)()
], DatabaseConnectionTestService);
//# sourceMappingURL=database-connection-test.service.js.map