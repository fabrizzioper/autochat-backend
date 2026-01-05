import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.string().transform(Number),
  CORS_ORIGINS: z.string().transform(v => v.split(',')),
  JWT_SECRET: z.string(),
  EXCEL_PROCESSOR_URL: z.string().default('http://localhost:8001'),
  EXCEL_PROCESSOR_PORT: z.string().transform(Number).optional(),
  
  DB_HOST: z.string(),
  DB_PORT: z.string().transform(Number),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_SYNC: z.string().transform(v => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;
