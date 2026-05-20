"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ApiExceptionFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const safe_log_1 = require("../logging/safe-log");
let ApiExceptionFilter = ApiExceptionFilter_1 = class ApiExceptionFilter {
    constructor() {
        this.logger = new common_1.Logger(ApiExceptionFilter_1.name);
    }
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest();
        const isHttp = exception instanceof common_1.HttpException;
        const status = isHttp
            ? exception.getStatus()
            : common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        const raw = isHttp ? exception.getResponse() : null;
        let message = 'Request failed.';
        let code;
        if (exception instanceof client_1.Prisma.PrismaClientKnownRequestError) {
            const meta = (0, safe_log_1.safeRequestMeta)(request.method, request.url);
            if (exception.code === 'P2002') {
                response.status(common_1.HttpStatus.CONFLICT).json({
                    ok: false,
                    error: {
                        statusCode: common_1.HttpStatus.CONFLICT,
                        message: 'A record with this value already exists.',
                        code: 'DUPLICATE',
                    },
                    timestamp: new Date().toISOString(),
                    path: request.url.split('?')[0],
                });
                this.logger.warn(JSON.stringify({ event: 'api.prisma_conflict', ...meta, prismaCode: exception.code }));
                return;
            }
            if (exception.code === 'P2025') {
                response.status(common_1.HttpStatus.NOT_FOUND).json({
                    ok: false,
                    error: {
                        statusCode: common_1.HttpStatus.NOT_FOUND,
                        message: 'The requested resource was not found.',
                        code: 'NOT_FOUND',
                    },
                    timestamp: new Date().toISOString(),
                    path: request.url.split('?')[0],
                });
                this.logger.warn(JSON.stringify({ event: 'api.prisma_not_found', ...meta, prismaCode: exception.code }));
                return;
            }
            this.logger.error(JSON.stringify({
                event: 'api.prisma_error',
                ...(0, safe_log_1.safeRequestMeta)(request.method, request.url),
                prismaCode: exception.code,
            }));
            response.status(common_1.HttpStatus.BAD_REQUEST).json({
                ok: false,
                error: {
                    statusCode: common_1.HttpStatus.BAD_REQUEST,
                    message: 'The request could not be completed. Please check your input.',
                    code: 'DATABASE_ERROR',
                },
                timestamp: new Date().toISOString(),
                path: request.url.split('?')[0],
            });
            return;
        }
        if (typeof raw === 'string') {
            message = raw;
        }
        else if (raw && typeof raw === 'object' && 'message' in raw) {
            const obj = raw;
            const value = obj.message;
            code = typeof obj.code === 'string' ? obj.code : undefined;
            if (typeof value === 'string')
                message = value;
            else if (Array.isArray(value) && typeof value[0] === 'string') {
                message = value[0];
            }
        }
        else if (exception instanceof Error && exception.message) {
            message = exception.message;
        }
        if (status >= 500) {
            this.logger.error(JSON.stringify({
                event: 'api.unhandled_error',
                ...(0, safe_log_1.safeRequestMeta)(request.method, request.url),
                status,
                errorName: exception instanceof Error ? exception.name : 'unknown',
            }));
            message = 'Something went wrong. Please try again.';
            code = code ?? 'INTERNAL_ERROR';
        }
        response.status(status).json({
            ok: false,
            error: {
                statusCode: status,
                message,
                ...(code ? { code } : {}),
            },
            timestamp: new Date().toISOString(),
            path: request.url.split('?')[0],
        });
    }
};
exports.ApiExceptionFilter = ApiExceptionFilter;
exports.ApiExceptionFilter = ApiExceptionFilter = ApiExceptionFilter_1 = __decorate([
    (0, common_1.Catch)()
], ApiExceptionFilter);
//# sourceMappingURL=api-exception.filter.js.map