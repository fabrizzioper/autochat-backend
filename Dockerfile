# Etapa 1: Build desde GitHub
FROM node:20-alpine AS builder

WORKDIR /app

# Instalar git
RUN apk add --no-cache git

# Clonar repositorio desde GitHub
RUN git clone https://github.com/fabrizzioper/autochat-backend.git . && \
    rm -rf .git

# Instalar dependencias
RUN npm ci

# Compilar TypeScript
RUN npm run build

# Etapa 2: Production
FROM node:20-alpine

WORKDIR /app

# Instalar dumb-init para manejar señales correctamente
RUN apk add --no-cache dumb-init

# Copiar package.json y package-lock.json desde builder
COPY --from=builder /app/package*.json ./

# Instalar solo dependencias de producción
RUN npm ci --only=production && npm cache clean --force

# Copiar código compilado desde builder
COPY --from=builder /app/dist ./dist

# Crear usuario no-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Crear directorios necesarios
RUN mkdir -p /app/temp /app/auth_info && \
    chown -R nodejs:nodejs /app

# Cambiar a usuario no-root
USER nodejs

# Exponer puerto
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Usar dumb-init como entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Comando de inicio
CMD ["node", "dist/main"]
