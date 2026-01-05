-- Migración de message_templates: de keyword/searchColumn a keywords/searchColumns (arrays JSON)
-- Ejecutar: psql -h localhost -U root -d autochat_db -f migrate-message-templates.sql

BEGIN;

-- 1. Agregar las nuevas columnas como nullable temporalmente
ALTER TABLE message_templates 
ADD COLUMN IF NOT EXISTS keywords JSON,
ADD COLUMN IF NOT EXISTS "searchColumns" JSON;

-- 2. Migrar datos existentes: convertir keyword y searchColumn a arrays JSON
UPDATE message_templates 
SET 
  keywords = CASE 
    WHEN keyword IS NOT NULL AND keyword != '' THEN json_build_array(keyword)
    ELSE json_build_array()
  END,
  "searchColumns" = CASE 
    WHEN "searchColumn" IS NOT NULL AND "searchColumn" != '' THEN json_build_array("searchColumn")
    ELSE json_build_array()
  END
WHERE keywords IS NULL OR "searchColumns" IS NULL;

-- 3. Hacer las nuevas columnas NOT NULL con valores por defecto
ALTER TABLE message_templates 
ALTER COLUMN keywords SET DEFAULT '[]'::json,
ALTER COLUMN "searchColumns" SET DEFAULT '[]'::json;

UPDATE message_templates 
SET keywords = '[]'::json WHERE keywords IS NULL;

UPDATE message_templates 
SET "searchColumns" = '[]'::json WHERE "searchColumns" IS NULL;

ALTER TABLE message_templates 
ALTER COLUMN keywords SET NOT NULL,
ALTER COLUMN "searchColumns" SET NOT NULL;

-- 4. Eliminar las columnas antiguas
ALTER TABLE message_templates DROP COLUMN IF EXISTS keyword;
ALTER TABLE message_templates DROP COLUMN IF EXISTS "searchColumn";

COMMIT;

-- Verificar migración
SELECT id, name, keywords, "searchColumns" FROM message_templates LIMIT 5;

