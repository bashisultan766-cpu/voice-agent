import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as express from 'express';
import { assertProductionEnvOrExit } from './common/env-validation';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
  assertProductionEnvOrExit();
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );
  app.setGlobalPrefix('api', {
    exclude: [{ path: '/', method: RequestMethod.GET }],
  });
  // Shopify webhook HMAC validation requires the exact raw request body.
  (app.getHttpAdapter().getInstance() as express.Express).use(
    '/api/integrations/shopify/webhooks',
    express.raw({ type: '*/*' }),
  );
  const cors = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: cors ? cors.split(',').map((o) => o.trim()) : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
  });
  if (process.env.TRUST_PROXY === 'true') {
    (app.getHttpAdapter().getInstance() as express.Express).set('trust proxy', 1);
  }
  app.use(express.urlencoded({ extended: false }));
  const port = Number(process.env.PORT ?? 3001);
  if (process.env.NODE_ENV !== 'production' && port === 3000) {
    console.warn(
      '\n[api] WARNING: API is listening on PORT=3000. The Next.js admin is meant to use 3000; set PORT=3001 in apps/api/.env (see apps/api/.env.example).\n',
    );
  }
  await app.listen(port);
  console.log(`[api] http://127.0.0.1:${port}/  (JSON) · http://127.0.0.1:${port}/api/health · Admin UI: http://127.0.0.1:3000`);
}

bootstrap();
