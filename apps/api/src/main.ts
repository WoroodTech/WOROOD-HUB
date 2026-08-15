import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors';
import { config } from './common/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Required for Shopify webhook HMAC verification: the signature covers the
    // raw body bytes, so they must survive body parsing.
    rawBody: true,
    logger: ['log', 'warn', 'error'],
  });

  // Versioned in the path so a future breaking change can be introduced
  // alongside the current version rather than in place of it.
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
  }));
  app.enableCors({ origin: [config.portalOrigin, /localhost:\d+$/], credentials: true });

  await app.listen(config.port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `WOROOD HUB API on :${config.port}  (Shopify source: ${config.shopify.tokenStrategy})`);
}
bootstrap();
