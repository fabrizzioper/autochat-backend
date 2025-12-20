import * as dotenv from 'dotenv';
import * as path from 'path';

// Cargar variables de entorno ANTES que cualquier otra cosa
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { createDatabaseIfNotExists } from './config/create-database';

async function bootstrap() {
  // Crear base de datos si no existe
  await createDatabaseIfNotExists();

  const app = await NestFactory.create(AppModule);
  
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  });
  
  await app.listen(env.PORT);
  console.log(`🚀 Backend corriendo en http://localhost:${env.PORT}`);
}
bootstrap();
