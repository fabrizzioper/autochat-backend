# Actualización del .env

Agrega estas líneas a tu archivo `.env` del backend:

```env
# Microservicio de procesamiento de Excel (Python)
EXCEL_PROCESSOR_URL=http://localhost:8001
EXCEL_PROCESSOR_PORT=8001
```

**Tu .env completo debería quedar así:**

```env
PORT=3000
CORS_ORIGINS=http://localhost:5173,https://wspsystem.vercel.app
DB_HOST=localhost
DB_PORT=5432
DB_USER=root
DB_PASSWORD=password
DB_NAME=autochat_db
DB_SYNC=true
JWT_SECRET=mi_super_secreto_jwt_autochat_2025_seguro

# Microservicio de procesamiento de Excel (Python)
EXCEL_PROCESSOR_URL=http://localhost:8001
EXCEL_PROCESSOR_PORT=8001
```

**Nota**: El microservicio Python usa automáticamente las mismas variables de BD (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) del mismo `.env`.

