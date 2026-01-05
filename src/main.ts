import * as dotenv from 'dotenv';
import * as path from 'path';
import * as express from 'express';

// Cargar variables de entorno ANTES que cualquier otra cosa
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { createDatabaseIfNotExists } from './config/create-database';

async function bootstrap() {
  // Crear base de datos si no existe
  await createDatabaseIfNotExists();

  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });
  
  // Configurar límites de tamaño para archivos grandes (hasta 200MB)
  // Acceder al adaptador de Express para configurar límites
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use(express.json({ limit: '200mb' }));
  expressApp.use(express.urlencoded({ limit: '200mb', extended: true }));
  
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  });
  
  await app.listen(env.PORT);
  console.log(`🚀 Backend corriendo en http://localhost:${env.PORT}`);
}
bootstrap();
