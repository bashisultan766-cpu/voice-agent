"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const app_module_1 = require("./app.module");
const express = require("express");
const env_validation_1 = require("./common/env-validation");
const api_exception_filter_1 = require("./common/filters/api-exception.filter");
async function bootstrap() {
    (0, env_validation_1.assertProductionEnvOrExit)();
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.useGlobalFilters(new api_exception_filter_1.ApiExceptionFilter());
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
    }));
    app.setGlobalPrefix('api', {
        exclude: [{ path: '/', method: common_1.RequestMethod.GET }],
    });
    app.getHttpAdapter().getInstance().use('/api/integrations/shopify/webhooks', express.raw({ type: '*/*' }));
    const cors = process.env.CORS_ORIGIN;
    app.enableCors({
        origin: cors ? cors.split(',').map((o) => o.trim()) : ['http://localhost:3000', 'http://127.0.0.1:3000'],
        credentials: true,
    });
    if (process.env.TRUST_PROXY === 'true') {
        app.getHttpAdapter().getInstance().set('trust proxy', 1);
    }
    app.use(express.urlencoded({ extended: false }));
    const port = Number(process.env.PORT ?? 3001);
    if (process.env.NODE_ENV !== 'production' && port === 3000) {
        console.warn('\n[api] WARNING: API is listening on PORT=3000. The Next.js admin is meant to use 3000; set PORT=3001 in apps/api/.env (see apps/api/.env.example).\n');
    }
    await app.listen(port);
    console.log(`[api] http://127.0.0.1:${port}/  (JSON) · http://127.0.0.1:${port}/api/health · Admin UI: http://127.0.0.1:3000`);
}
bootstrap();
//# sourceMappingURL=main.js.map