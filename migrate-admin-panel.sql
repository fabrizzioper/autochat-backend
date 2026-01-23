-- Migración para el Panel de Administración
-- Ejecutar en la base de datos PostgreSQL

-- 1. Agregar columna isAdmin a la tabla users
ALTER TABLE users ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN DEFAULT FALSE;

-- 2. Crear tabla para logs de actividad de usuarios
CREATE TABLE IF NOT EXISTS user_activity_logs (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "activityType" VARCHAR(50) NOT NULL,
  "ipAddress" VARCHAR(100),
  "userAgent" TEXT,
  details TEXT,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para la tabla de logs
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id ON user_activity_logs("userId");
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_created ON user_activity_logs("userId", "createdAt");

-- 3. Crear tabla para estadísticas de mensajes
CREATE TABLE IF NOT EXISTS message_stats (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "authorizedNumberId" INTEGER NOT NULL,
  "phoneNumber" VARCHAR(50) NOT NULL,
  direction VARCHAR(20) NOT NULL,
  "messageType" VARCHAR(50) NOT NULL,
  details TEXT,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para la tabla de estadísticas
CREATE INDEX IF NOT EXISTS idx_message_stats_user_id ON message_stats("userId");
CREATE INDEX IF NOT EXISTS idx_message_stats_authorized_number ON message_stats("authorizedNumberId");
CREATE INDEX IF NOT EXISTS idx_message_stats_composite ON message_stats("userId", "authorizedNumberId", "createdAt");

-- 4. Hacer admin al primer usuario (opcional - ajustar el email según necesites)
-- UPDATE users SET "isAdmin" = TRUE WHERE email = 'tu-email@ejemplo.com';

-- Verificar las tablas creadas
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user_activity_logs', 'message_stats');

-- Verificar que la columna isAdmin existe
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'isAdmin';
