/**
 * Environment configuration. Validated once at boot so a misconfigured
 * instance fails immediately rather than at the first request.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtl: number; // seconds
  jwtRefreshTtl: number; // seconds
  corsOrigins: string[];
  defaultTimezone: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];

  const config: AppConfig = {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtAccessSecret: required('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
    jwtAccessTtl: Number(process.env.JWT_ACCESS_TTL ?? 900),
    jwtRefreshTtl: Number(process.env.JWT_REFRESH_TTL ?? 2_592_000),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? 'Africa/Cairo',
  };

  if (config.nodeEnv === 'production') {
    const weak = ['dev-access-secret-change-me', 'dev-refresh-secret-change-me', 'changeme'];
    if (weak.includes(config.jwtAccessSecret) || weak.includes(config.jwtRefreshSecret)) {
      throw new Error('Refusing to start in production with development JWT secrets.');
    }
    if (config.jwtAccessSecret.length < 32 || config.jwtRefreshSecret.length < 32) {
      throw new Error('JWT secrets must be at least 32 characters in production.');
    }
  }

  return config;
}
