import { envSchema, Env } from './env.schema';

// Las variables de entorno ya se cargan en main.ts
envSchema.parse(process.env);

export const env: Env = {
  PORT: Number(process.env.PORT),
  CORS_ORIGINS: process.env.CORS_ORIGINS!.split(','),
  JWT_SECRET: process.env.JWT_SECRET!,
  DB_HOST: process.env.DB_HOST!,
  DB_PORT: Number(process.env.DB_PORT),
  DB_USER: process.env.DB_USER!,
  DB_PASSWORD: process.env.DB_PASSWORD!,
  DB_NAME: process.env.DB_NAME!,
  DB_SYNC: process.env.DB_SYNC === 'true',
};

