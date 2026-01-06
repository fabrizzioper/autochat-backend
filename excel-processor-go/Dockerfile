# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Instalar dependencias de compilación
RUN apk add --no-cache gcc musl-dev

# Copiar archivos de módulo
COPY go.mod go.sum* ./

# Descargar dependencias
RUN go mod download

# Copiar código fuente
COPY *.go ./

# Compilar binario estático
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o excel-processor .

# Runtime stage - imagen mínima
FROM alpine:3.19

WORKDIR /app

# Instalar certificados SSL y wget para healthcheck
RUN apk --no-cache add ca-certificates tzdata wget

# Copiar binario desde builder
COPY --from=builder /app/excel-processor .

# Puerto
EXPOSE 8001

# Ejecutar
CMD ["./excel-processor"]

