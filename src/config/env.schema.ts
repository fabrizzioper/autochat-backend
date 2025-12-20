import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.string().transform(Number),
  CORS_ORIGINS: z.string().transform(v => v.split(',')),
  JWT_SECRET: z.string(),
  
  DB_HOST: z.string(),
  DB_PORT: z.string().transform(Number),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_SYNC: z.string().transform(v => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;
