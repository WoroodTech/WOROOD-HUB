import 'reflect-metadata';
import 'dotenv/config';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Behind the nginx reverse proxy on EC2, so trust X-Forwarded-* headers.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(compression());

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (config.nodeEnv !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('WOROOD HUB API')
        .setDescription('Modular enterprise intranet platform — Meeting Rooms module')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`WOROOD HUB API listening on port ${config.port} (${config.nodeEnv})`);
  if (config.nodeEnv !== 'production') logger.log(`API docs: http://localhost:${config.port}/api/docs`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start WOROOD HUB API:', error);
  process.exit(1);
});
