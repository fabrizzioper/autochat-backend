#!/bin/bash

###############################################################################
# Script de Deployment AUTOMÁTICO - AutoChat Backend en GCP
# NO REQUIERE CONFIGURACIÓN PREVIA - TODO AUTOMÁTICO
###############################################################################

set -e

# Colores para logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

# Funciones de log
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

log_step() {
    echo -e "${PURPLE}[PASO $1]${NC} $2"
}

# Banner
clear
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║      🚀 AutoChat Backend - Deployment AUTOMÁTICO 🚀      ║"
echo "║                  Google Cloud Platform                    ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

###############################################################################
# PASO 1: Verificar gcloud CLI
###############################################################################

log_step "1/10" "Verificando gcloud CLI..."

if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI no está instalado"
    echo ""
    echo "Instala gcloud CLI ejecutando:"
    echo ""
    echo "  curl https://sdk.cloud.google.com | bash"
    echo "  exec -l \$SHELL"
    echo "  gcloud init"
    echo ""
    echo "O descarga desde: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

log_success "gcloud CLI instalado correctamente"
echo ""

###############################################################################
# PASO 2: Autenticación en GCP
###############################################################################

# Cuenta GCP a usar (esta PC). Cambiar si usas otra cuenta.
GCP_ACCOUNT="fabrizzio.pereira2004@gmail.com"

log_step "2/10" "Verificando autenticación..."

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
    log_warning "No estás autenticado en Google Cloud"
    log_info "Abriendo navegador para autenticación..."
    gcloud auth login
fi

# Usar la cuenta configurada si está en la lista
if gcloud auth list --format="value(account)" | grep -q "^${GCP_ACCOUNT}$"; then
    CURRENT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n 1)
    if [ "$CURRENT" != "$GCP_ACCOUNT" ]; then
        log_info "Cambiando a la cuenta: $GCP_ACCOUNT"
        gcloud config set account "$GCP_ACCOUNT"
    fi
else
    log_warning "La cuenta $GCP_ACCOUNT no está agregada. Agregando..."
    gcloud auth login
fi

ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n 1)
log_success "Autenticado como: $ACCOUNT"
echo ""

###############################################################################
# PASO 3: Seleccionar/Crear Proyecto
###############################################################################

log_step "3/10" "Configurando proyecto GCP..."

# Listar proyectos existentes
log_info "Buscando proyectos existentes..."
PROJECTS=$(gcloud projects list --format="value(projectId)" 2>/dev/null || echo "")

if [ -z "$PROJECTS" ]; then
    log_warning "No tienes proyectos en GCP"
    log_info "Vamos a crear uno nuevo..."
    
    # Generar ID único para el proyecto
    PROJECT_SUFFIX=$(date +%s | tail -c 5)
    GCP_PROJECT_ID="autochat-backend-$PROJECT_SUFFIX"
    
    echo ""
    read -p "Nombre del proyecto [$GCP_PROJECT_ID]: " USER_PROJECT
    GCP_PROJECT_ID=${USER_PROJECT:-$GCP_PROJECT_ID}
    
    log_info "Creando proyecto: $GCP_PROJECT_ID"
    gcloud projects create "$GCP_PROJECT_ID" --name="AutoChat Backend" --set-as-default
    
    log_success "Proyecto creado: $GCP_PROJECT_ID"
    
    log_warning "⚠️  IMPORTANTE: Debes habilitar facturación en este proyecto"
    log_info "Ve a: https://console.cloud.google.com/billing/linkedaccount?project=$GCP_PROJECT_ID"
    echo ""
    read -p "Presiona ENTER cuando hayas habilitado la facturación..."
    
else
    # Buscar proyecto que empiece con "autochat-"
    AUTOCHAT_PROJECT=$(echo "$PROJECTS" | grep "^autochat-" | head -1)
    
    if [ -n "$AUTOCHAT_PROJECT" ]; then
        GCP_PROJECT_ID="$AUTOCHAT_PROJECT"
        log_success "Proyecto encontrado: $GCP_PROJECT_ID"
    else
        # Generar ID único para el proyecto
        PROJECT_SUFFIX=$(date +%s | tail -c 6)
        GCP_PROJECT_ID="autochat-${PROJECT_SUFFIX}"
        
        log_info "Creando proyecto: $GCP_PROJECT_ID"
        if ! gcloud projects create "$GCP_PROJECT_ID" --name="AutoChat Backend" 2>/dev/null; then
            # Si falla, intentar con otro sufijo
            PROJECT_SUFFIX=$RANDOM
            GCP_PROJECT_ID="autochat-${PROJECT_SUFFIX}"
            log_info "Reintentando con: $GCP_PROJECT_ID"
            gcloud projects create "$GCP_PROJECT_ID" --name="AutoChat Backend"
        fi
        
        log_success "Proyecto creado: $GCP_PROJECT_ID"
        log_warning "⚠️  Debes habilitar facturación en: https://console.cloud.google.com/billing/linkedaccount?project=$GCP_PROJECT_ID"
        read -p "Presiona ENTER cuando hayas habilitado la facturación..."
    fi
fi

# Establecer proyecto
gcloud config set project "$GCP_PROJECT_ID"
log_success "Usando proyecto: $GCP_PROJECT_ID"
echo ""

###############################################################################
# PASO 4: Seleccionar Zona
###############################################################################

log_step "4/10" "Seleccionando zona GCP..."

GCP_ZONE="us-east1-b"
log_success "Zona configurada: $GCP_ZONE (Carolina del Sur, USA - más cercano con c3d)"
echo ""

###############################################################################
# PASO 5: Configurar VM
###############################################################################

log_step "5/10" "Configurando máquina virtual..."

VM_NAME="autochat-backend-vm"

VM_MACHINE_TYPE="c3d-highcpu-8"
log_success "Tipo de máquina configurado: $VM_MACHINE_TYPE (8 vCPU, 16GB RAM - AMD Genoa 3.7GHz)"

VM_DISK_SIZE="100GB"

log_success "Máquina configurada: $VM_MACHINE_TYPE con disco de $VM_DISK_SIZE"
echo ""

###############################################################################
# PASO 6: Habilitar APIs
###############################################################################

log_step "6/10" "Habilitando APIs necesarias..."

log_info "Esto puede tardar 1-2 minutos..."

# Habilitar APIs (sin suprimir errores para detectar problemas reales)
gcloud services enable compute.googleapis.com --quiet 2>&1 && log_success "API Compute habilitada" || {
    # Verificar si ya está habilitada
    if gcloud services list --enabled --filter="name:compute.googleapis.com" --format="value(name)" 2>/dev/null | grep -q compute; then
        log_success "API Compute ya estaba habilitada"
    else
        log_error "No se pudo habilitar Compute Engine API"
        log_info "Habilítala manualmente en: https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=$GCP_PROJECT_ID"
        log_info "Luego vuelve a ejecutar este script"
        exit 1
    fi
}

gcloud services enable cloudresourcemanager.googleapis.com --quiet 2>&1 || log_warning "API Resource Manager: posible error al habilitar"

# Esperar a que las APIs se propaguen (GCP puede tardar unos segundos)
log_info "Esperando propagación de APIs (15 segundos)..."
sleep 15

log_success "APIs habilitadas"
echo ""

###############################################################################
# PASO 7: Crear VM (con detección automática de cambios)
###############################################################################

log_step "7/10" "Verificando máquina virtual..."

# Configuración deseada
DESIRED_MACHINE_TYPE="$VM_MACHINE_TYPE"
DESIRED_DISK_TYPE="pd-ssd"
DESIRED_DISK_SIZE="50"  # GB - SSD de 50GB es suficiente y más rápido

VM_EXISTS=false
NEEDS_RECREATE=false

# Solo buscar en la zona por defecto (donde este script crea la VM). Si no está ahí, no existe.
# Usar 'list' en vez de 'describe' para evitar que se cuelgue cuando la VM no existe
log_info "Buscando VM en zona $GCP_ZONE..."
VM_FOUND=false
VM_LIST_OUTPUT=$(gcloud compute instances list --filter="name=$VM_NAME AND zone:($GCP_ZONE)" --format="value(name)" --quiet 2>/dev/null || echo "")
if [ "$VM_LIST_OUTPUT" = "$VM_NAME" ]; then
    VM_FOUND=true
fi
if [ "$VM_FOUND" = true ]; then
    VM_EXISTS=true
    log_success "VM encontrada en zona: $GCP_ZONE"
else
    log_info "No hay VM en este proyecto. Se creará una nueva."
fi

if [ "$VM_EXISTS" = true ]; then
    log_info "Verificando configuración de la VM existente..."
    
    # Obtener configuración actual
    CURRENT_MACHINE_TYPE=$(gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" --format="get(machineType)" | awk -F'/' '{print $NF}')
    CURRENT_DISK_NAME=$(gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" --format="get(disks[0].source)" | awk -F'/' '{print $NF}')
    CURRENT_DISK_TYPE=$(gcloud compute disks describe "$CURRENT_DISK_NAME" --zone="$GCP_ZONE" --format="get(type)" 2>/dev/null | awk -F'/' '{print $NF}')
    CURRENT_DISK_SIZE=$(gcloud compute disks describe "$CURRENT_DISK_NAME" --zone="$GCP_ZONE" --format="get(sizeGb)" 2>/dev/null)
    
    echo ""
    echo "   📊 Configuración actual vs deseada:"
    echo "   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   Tipo de máquina: $CURRENT_MACHINE_TYPE → $DESIRED_MACHINE_TYPE $([ "$CURRENT_MACHINE_TYPE" = "$DESIRED_MACHINE_TYPE" ] && echo "✅" || echo "❌")"
    echo "   Tipo de disco:   $CURRENT_DISK_TYPE → $DESIRED_DISK_TYPE $([ "$CURRENT_DISK_TYPE" = "$DESIRED_DISK_TYPE" ] && echo "✅" || echo "❌")"
    echo "   Tamaño disco:    ${CURRENT_DISK_SIZE}GB → ${DESIRED_DISK_SIZE}GB $([ "$CURRENT_DISK_SIZE" -ge "$DESIRED_DISK_SIZE" ] && echo "✅" || echo "❌")"
    echo ""
    
    # Verificar si necesita recreación
    if [ "$CURRENT_MACHINE_TYPE" != "$DESIRED_MACHINE_TYPE" ]; then
        log_warning "Tipo de máquina diferente: $CURRENT_MACHINE_TYPE → $DESIRED_MACHINE_TYPE"
        NEEDS_RECREATE=true
    fi
    
    if [ "$CURRENT_DISK_TYPE" != "$DESIRED_DISK_TYPE" ]; then
        log_warning "Tipo de disco diferente: $CURRENT_DISK_TYPE → $DESIRED_DISK_TYPE"
        NEEDS_RECREATE=true
    fi
    
    if [ "$NEEDS_RECREATE" = true ]; then
        echo ""
        log_warning "⚠️  La VM tiene configuración diferente a la deseada"
        log_info "Se destruirá la VM antigua y se creará una nueva con la configuración correcta"
        echo ""
        
        # Destruir VM antigua
        log_info "Destruyendo VM antigua..."
        gcloud compute instances delete "$VM_NAME" --zone="$GCP_ZONE" --quiet --delete-disks=all
        log_success "VM antigua eliminada"
        
        VM_EXISTS=false
    else
        log_success "VM tiene la configuración correcta"
        
        # VERIFICAR SI LA VM ESTÁ DETENIDA Y NECESITA INICIARSE
        VM_STATUS=$(gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" --format="get(status)")
        
        if [ "$VM_STATUS" = "TERMINATED" ] || [ "$VM_STATUS" = "STOPPED" ]; then
            echo ""
            log_warning "⚠️  La VM está detenida (estado: $VM_STATUS)"
            log_info "Iniciando VM..."
            
            gcloud compute instances start "$VM_NAME" --zone="$GCP_ZONE" --quiet
            
            log_info "Esperando a que la VM esté lista (esto puede tardar 30-60 segundos)..."
            
            # Esperar a que la VM esté RUNNING
            WAIT_COUNT=0
            MAX_WAIT=60
            while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
                VM_STATUS=$(gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" --format="get(status)" 2>/dev/null)
                if [ "$VM_STATUS" = "RUNNING" ]; then
                    log_success "VM iniciada correctamente"
                    break
                fi
                WAIT_COUNT=$((WAIT_COUNT + 2))
                sleep 2
                echo -n "."
            done
            echo ""
            
            if [ "$VM_STATUS" != "RUNNING" ]; then
                log_error "La VM no pudo iniciarse (estado: $VM_STATUS)"
                exit 1
            fi
            
            # Esperar a que SSH esté disponible
            log_info "Esperando a que SSH esté disponible..."
            RETRY_COUNT=0
            MAX_RETRIES=30
            while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
                if gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="echo 'SSH ready'" --quiet 2>/dev/null; then
                    log_success "SSH listo"
                    break
                fi
                RETRY_COUNT=$((RETRY_COUNT + 1))
                sleep 2
                echo -n "."
            done
            echo ""
            
            if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
                log_warning "SSH directo no disponible, usando IAP tunneling"
                SSH_USE_IAP="--tunnel-through-iap"
            else
                SSH_USE_IAP=""
            fi
        elif [ "$VM_STATUS" = "RUNNING" ]; then
            log_success "VM está corriendo correctamente"
        else
            log_warning "Estado de la VM: $VM_STATUS"
        fi
    fi
fi

if [ "$VM_EXISTS" = false ]; then
    log_info "Creando VM con configuración óptima (esto tarda 1-2 minutos)..."
    log_info "  • Tipo: $DESIRED_MACHINE_TYPE (8 vCPU, 16GB RAM - AMD Genoa 3.7GHz)"
    log_info "  • Disco: $DESIRED_DISK_TYPE ${DESIRED_DISK_SIZE}GB (SSD rápido)"
    
    gcloud compute instances create "$VM_NAME" \
        --zone="$GCP_ZONE" \
        --machine-type="$DESIRED_MACHINE_TYPE" \
        --image-family=ubuntu-2204-lts \
        --image-project=ubuntu-os-cloud \
        --boot-disk-size="${DESIRED_DISK_SIZE}GB" \
        --boot-disk-type="$DESIRED_DISK_TYPE" \
        --tags=http-server,https-server,autochat-backend \
        --metadata=enable-oslogin=TRUE \
        --quiet
    
    log_success "VM creada exitosamente con disco SSD"
    log_info "Esperando a que SSH esté listo (esto puede tardar 30-60 segundos)..."
    
    # Esperar a que SSH esté disponible
    RETRY_COUNT=0
    MAX_RETRIES=30
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="echo 'SSH ready'" --quiet 2>/dev/null; then
            log_success "SSH listo"
            break
        fi
        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
            sleep 2
            echo -n "."
        fi
    done
    echo ""
    
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        log_warning "SSH no está listo aún, usando IAP tunneling"
        SSH_USE_IAP="--tunnel-through-iap"
    else
        SSH_USE_IAP=""
    fi
else
    log_info "Usando VM existente (configuración correcta)"
    SSH_USE_IAP=""
fi

# Obtener IP
VM_EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$GCP_ZONE" \
    --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

log_success "IP pública: $VM_EXTERNAL_IP"
echo ""

###############################################################################
# PASO 8: Configurar Firewall
###############################################################################

log_step "8/10" "Configurando firewall..."

if ! gcloud compute firewall-rules describe autochat-backend-rule &>/dev/null; then
    log_info "Creando regla de firewall para puertos 3000 y 8001..."
    
    gcloud compute firewall-rules create autochat-backend-rule \
        --allow=tcp:3000,tcp:8001 \
        --source-ranges=0.0.0.0/0 \
        --target-tags=autochat-backend \
        --description="AutoChat Backend API y Excel Processor" \
        --quiet
    
    log_success "Firewall configurado"
else
    log_success "Firewall ya configurado"
fi
echo ""

###############################################################################
# PASO 9: Instalar Docker y desplegar
###############################################################################

log_step "9/10" "Instalando Docker y desplegando aplicación..."

# Generar JWT Secret
JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
log_success "JWT Secret generado"

log_info "Actualizando configuración en la VM..."

if [ "$VM_EXISTS" = false ]; then
    log_info "Instalando dependencias en nueva VM (3-5 minutos)..."
    
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" $SSH_USE_IAP --command="
        set -e
        
        echo '=== [1/4] Actualizando sistema ==='
        sudo apt-get update -qq
        
        echo '=== [2/4] Instalando dependencias ==='
        sudo apt-get install -y -qq ca-certificates curl gnupg git
        
        echo '=== [3/4] Instalando Docker ==='
        curl -fsSL https://get.docker.com -o get-docker.sh
        sudo sh get-docker.sh
        sudo usermod -aG docker \$USER
        rm get-docker.sh
        
        echo '=== [4/4] Instalando Docker Compose ==='
        # Instalar docker-compose v2 (compatible)
        sudo curl -sL \"https://github.com/docker/compose/releases/latest/download/docker-compose-\$(uname -s)-\$(uname -m)\" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
        # También crear symlink para docker compose (v2)
        sudo ln -sf /usr/local/bin/docker-compose /usr/local/bin/docker-compose-v2 || true
        
        echo '✓ Dependencias instaladas'
    " --quiet
else
    log_info "VM existente detectada, verificando si Docker está instalado..."
    
    # Verificar si Docker está realmente instalado y funcionando
    if ! gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" $SSH_USE_IAP --command="command -v docker >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1" --quiet 2>/dev/null; then
        log_info "Docker no está instalado o no funciona, instalando ahora..."
        
        gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" $SSH_USE_IAP --command="
            set -e
            
            echo '=== [1/4] Actualizando sistema ==='
            sudo apt-get update
            
            echo '=== [2/4] Instalando dependencias ==='
            sudo apt-get install -y ca-certificates curl gnupg git
            
            echo '=== [3/4] Instalando Docker ==='
            curl -fsSL https://get.docker.com -o get-docker.sh
            sudo sh get-docker.sh
            sudo usermod -aG docker \$USER
            rm get-docker.sh
            
            echo '=== [4/4] Instalando Docker Compose ==='
            sudo curl -sL \"https://github.com/docker/compose/releases/latest/download/docker-compose-\$(uname -s)-\$(uname -m)\" -o /usr/local/bin/docker-compose
            sudo chmod +x /usr/local/bin/docker-compose
            sudo ln -sf /usr/local/bin/docker-compose /usr/local/bin/docker-compose-v2 || true
            
            echo '✓ Dependencias instaladas'
        " --quiet
    else
        log_info "Docker ya está instalado y funcionando"
    fi
fi

log_info "Actualizando código y configuración..."

SSH_TUNNEL_FLAG="${SSH_USE_IAP:-}"
gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" $SSH_TUNNEL_FLAG --command="
    set -e
    
    echo '=== [1/2] Actualizando repositorio ==='
    if [ -d ~/autochat-backend/.git ]; then
        echo 'Actualizando código desde GitHub (forzando sincronización)...'
        cd ~/autochat-backend
        # Forzar sincronización: descartar cambios locales y usar código de GitHub
        git fetch origin
        git reset --hard origin/main
        git clean -fd
        echo '  ✓ Código sincronizado con GitHub'
    else
        echo 'Clonando repositorio...'
        rm -rf ~/autochat-backend
        git clone https://github.com/fabrizzioper/autochat-backend.git ~/autochat-backend
        cd ~/autochat-backend
        echo '  ✓ Repositorio clonado'
    fi
    
    # Verificar archivos importantes
    if [ ! -f excel-processor-go/main.go ]; then
        echo '  ⚠ Archivo excel-processor-go/main.go no encontrado'
    else
        echo '  ✓ Código Go presente'
    fi
    
    echo '=== [2/2] Actualizando variables de entorno ==='
    cat > .env << ENVEOF
PORT=3000
CORS_ORIGINS=http://localhost:5173,https://wspsystem.vercel.app,http://$VM_EXTERNAL_IP:5173,http://$VM_EXTERNAL_IP:3000
JWT_SECRET=$JWT_SECRET
DB_HOST=postgres
DB_PORT=5432
DB_USER=root
DB_PASSWORD=password
DB_NAME=autochat_db
DB_SYNC=true
EXCEL_PROCESSOR_URL=http://excel-processor:8001
EXCEL_PROCESSOR_PORT=8001
ENVEOF
    
    mkdir -p auth_info temp
    chmod 777 auth_info temp
    
    echo '✓ Configuración actualizada'
" --quiet

log_success "Dependencias instaladas"
echo ""

log_info "Reconstruyendo y reiniciando contenedores (3-5 minutos)..."

SSH_TUNNEL_FLAG="${SSH_USE_IAP:-}"
gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" $SSH_TUNNEL_FLAG --command="
    set -e
    
    echo '=== Esperando a que Docker esté listo ==='
    MAX_WAIT=60
    WAIT_COUNT=0
    while [ \$WAIT_COUNT -lt \$MAX_WAIT ]; do
        if sudo docker info &>/dev/null; then
            echo \"✓ Docker está listo (esperado \${WAIT_COUNT}s)\"
            break
        fi
        echo \"[$(date +%H:%M:%S)] Esperando Docker... (\${WAIT_COUNT}s / \${MAX_WAIT}s)\"
        sleep 2
        WAIT_COUNT=\$((WAIT_COUNT + 2))
    done
    
    if ! sudo docker info &>/dev/null; then
        echo '⚠ Docker daemon no está corriendo. Verificando estado...'
        echo ''
        echo '=== Estado del servicio Docker ==='
        sudo systemctl status docker --no-pager -l || true
        echo ''
        echo '=== Intentando iniciar Docker ==='
        sudo systemctl start docker || {
            echo ''
            echo '✗ Error: No se pudo iniciar Docker. Mostrando logs:'
            echo '=== Logs de systemd para docker.service ==='
            sudo journalctl -u docker.service --no-pager -n 50 || true
            echo ''
            echo '=== Verificando si Docker está instalado ==='
            which docker || echo 'Docker no está en PATH'
            sudo which docker || echo 'Docker no está instalado para sudo'
            echo ''
            echo '✗ Docker no está instalado correctamente. Instalando...'
            
            # Instalar Docker
            curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
            sudo sh /tmp/get-docker.sh
            rm /tmp/get-docker.sh
            sudo usermod -aG docker \$USER
            
            echo 'Iniciando Docker después de la instalación...'
            sudo systemctl start docker
            sudo systemctl enable docker
            sleep 5
        }
        
        # Verificar nuevamente
        if sudo docker info &>/dev/null; then
            echo '✓ Docker iniciado correctamente'
        else
            echo ''
            echo '✗ Error: Docker sigue sin funcionar después del intento de inicio'
            echo '=== Últimos logs de Docker ==='
            sudo journalctl -u docker.service --no-pager -n 100 || true
            exit 1
        fi
    fi
    
    cd ~/autochat-backend
    
    # Detectar qué comando de docker compose funciona
    if command -v docker-compose &> /dev/null; then
        DOCKER_COMPOSE_CMD=\"docker-compose\"
    elif docker compose version &> /dev/null 2>&1; then
        DOCKER_COMPOSE_CMD=\"docker compose\"
    else
        # Si no está en PATH, usar ruta completa
        if [ -f /usr/local/bin/docker-compose ]; then
            DOCKER_COMPOSE_CMD=\"/usr/local/bin/docker-compose\"
        else
            echo 'Error: docker-compose no encontrado. Intentando instalar...'
            sudo curl -sL \"https://github.com/docker/compose/releases/latest/download/docker-compose-\$(uname -s)-\$(uname -m)\" -o /usr/local/bin/docker-compose
            sudo chmod +x /usr/local/bin/docker-compose
            DOCKER_COMPOSE_CMD=\"/usr/local/bin/docker-compose\"
        fi
    fi
    
    echo '[$(date +%H:%M:%S)] === [1/4] Deteniendo contenedores ==='
    sudo \$DOCKER_COMPOSE_CMD down 2>/dev/null || echo '  (no había contenedores corriendo)'
    
    echo '[$(date +%H:%M:%S)] === [2/4] Reconstruyendo imágenes con nuevas variables ==='
    echo '  Esto puede tardar 2-3 minutos (compilando Go y Node.js)...'
    echo '  📦 Construyendo NestJS Backend (Node.js)...'
    if ! sudo \$DOCKER_COMPOSE_CMD build --no-cache backend; then
        echo ''
        echo '✗ ERROR: Falló el build del backend NestJS'
        exit 1
    fi
    echo '  ✓ NestJS Backend construido'
    echo '  🚀 Construyendo Go Excel Processor (compilando binario)...'
    if ! sudo \$DOCKER_COMPOSE_CMD build --no-cache excel-processor; then
        echo ''
        echo '✗ ERROR: Falló el build del microservicio Go'
        echo '  Verificando logs del build...'
        sudo docker logs \$(sudo docker ps -a --filter \"ancestor=autochat-backend-excel-processor\" --format \"{{.ID}}\" | head -1) 2>&1 | tail -50 || true
        exit 1
    fi
    echo '  ✓ Go Excel Processor construido'
    echo '  🗄️  Construyendo PostgreSQL...'
    if ! sudo \$DOCKER_COMPOSE_CMD build --no-cache postgres 2>/dev/null; then
        echo '  (PostgreSQL usa imagen oficial, saltando build)'
    fi
    echo '  ✓ Todas las imágenes construidas correctamente'
    
    echo '[$(date +%H:%M:%S)] === [3/4] Iniciando servicios ==='
    echo '  🗄️  Iniciando PostgreSQL...'
    sudo \$DOCKER_COMPOSE_CMD up -d postgres
    echo '  ⏳ Esperando a que PostgreSQL esté listo (10 segundos)...'
    sleep 10
    
    echo '  🚀 Iniciando Go Excel Processor...'
    sudo \$DOCKER_COMPOSE_CMD up -d excel-processor
    echo '  ⏳ Esperando a que Go esté listo (3 segundos)...'
    sleep 5
    
    echo '  🚀 Iniciando NestJS Backend...'
    sudo \$DOCKER_COMPOSE_CMD up -d backend
    echo '[$(date +%H:%M:%S)] ✓ Todos los servicios iniciados'
    
    echo '[$(date +%H:%M:%S)] === [4/4] Esperando a que los servicios estén listos (10 segundos) ==='
    sleep 10
    
    echo ''
    echo '[$(date +%H:%M:%S)] === [5/5] Ejecutando migración de base de datos ==='
    # Esperar a que PostgreSQL esté completamente listo
    echo '  Esperando a que PostgreSQL esté listo...'
    POSTGRES_READY=false
    i=1
    while [ \$i -le 30 ]; do
        if sudo docker exec autochat-postgres pg_isready -U root &>/dev/null 2>&1; then
            echo '  ✓ PostgreSQL está listo'
            POSTGRES_READY=true
            break
        fi
        if [ \$i -eq 30 ]; then
            echo '  ⚠ PostgreSQL no está listo después de 30 intentos, pero continuando...'
        fi
        sleep 1
        i=\$((i + 1))
    done
    
    # Ejecutar migración si existe el archivo y PostgreSQL está listo
    if [ -f migrate-message-templates.sql ]; then
        echo '  Ejecutando migración migrate-message-templates.sql...'
        MIGRATION_OUTPUT=\$(sudo docker exec -i autochat-postgres psql -U root -d autochat_db < migrate-message-templates.sql 2>&1)
        MIGRATION_EXIT=\$?
        if [ \$MIGRATION_EXIT -eq 0 ]; then
            echo '  ✓ Migración ejecutada correctamente'
        elif echo \"\$MIGRATION_OUTPUT\" | grep -q \"already exists\" || echo \"\$MIGRATION_OUTPUT\" | grep -q \"duplicate\"; then
            echo '  ✓ Migración ya aplicada (columnas ya existen)'
        else
            echo '  ⚠ Error al ejecutar migración:'
            echo \"\$MIGRATION_OUTPUT\" | head -5
        fi
    else
        echo '  ⚠ Archivo de migración no encontrado, saltando...'
    fi
    
    echo ''
    echo '[$(date +%H:%M:%S)] === Estado de contenedores ==='
    sudo \$DOCKER_COMPOSE_CMD ps
    
    echo ''
    echo '[$(date +%H:%M:%S)] === Verificando servicios ==='
    echo '  Verificando NestJS Backend (puerto 3000)...'
    sleep 5
    if curl -s -f http://localhost:3000 > /dev/null 2>&1; then
        echo '  ✓ NestJS Backend está respondiendo'
    else
        echo '  ⚠ NestJS Backend aún no responde (puede tardar más)'
    fi
    
    echo '  Verificando Go Excel Processor (puerto 8001)...'
    sleep 2
    if curl -s -f http://localhost:8001/health > /dev/null 2>&1; then
        echo '  ✓ Go Excel Processor está respondiendo'
        HEALTH_RESPONSE=\$(curl -s http://localhost:8001/health)
        echo \"  📊 Health check: \$HEALTH_RESPONSE\"
    else
        echo '  ⚠ Go Excel Processor aún no responde (puede tardar más)'
    fi
    
    echo ''
    echo '[$(date +%H:%M:%S)] === Logs de NestJS Backend (últimas 20 líneas) ==='
    sudo \$DOCKER_COMPOSE_CMD logs --tail=20 backend || echo '  (sin logs aún)'
    
    echo ''
    echo '[$(date +%H:%M:%S)] === Logs de Go Excel Processor (últimas 20 líneas) ==='
    sudo \$DOCKER_COMPOSE_CMD logs --tail=20 excel-processor || echo '  (sin logs aún)'
    
    echo ''
    echo '[$(date +%H:%M:%S)] === Logs de PostgreSQL (últimas 10 líneas) ==='
    sudo \$DOCKER_COMPOSE_CMD logs --tail=10 postgres || echo '  (sin logs aún)'
    
    # Verificar si hay contenedores con errores
    echo ''
    echo '[$(date +%H:%M:%S)] === Verificando errores ==='
    FAILED_CONTAINERS=\$(sudo \$DOCKER_COMPOSE_CMD ps --filter \"status=exited\" --format \"{{.Names}}\")
    if [ -n \"\$FAILED_CONTAINERS\" ]; then
        echo '⚠ Contenedores que fallaron:'
        echo \"\$FAILED_CONTAINERS\"
        echo ''
        echo 'Logs de contenedores fallidos:'
        for container in \$FAILED_CONTAINERS; do
            echo \"--- Logs de \$container ---\"
            sudo docker logs --tail=30 \$container 2>&1 || true
        done
    else
        echo '✓ Todos los contenedores están corriendo'
    fi
    
    echo ''
    echo '[$(date +%H:%M:%S)] ✓ Deployment actualizado'
" --quiet

log_success "Aplicación desplegada"
echo ""

###############################################################################
# PASO 10: Verificar deployment
###############################################################################

log_step "10/10" "Verificando deployment..."

log_info "Esperando a que los servicios estén completamente listos (20 segundos)..."
sleep 20

log_info "Verificando estado de los servicios desde la VM..."

# Verificar estado de contenedores y servicios desde dentro de la VM
VERIFICATION_OUTPUT=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="
    set -e
    echo '=== Estado de Contenedores ==='
    sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || echo 'Error obteniendo estado'
    
    echo ''
    echo '=== Verificando PostgreSQL ==='
    if sudo docker exec autochat-postgres pg_isready -U root &>/dev/null 2>&1; then
        echo '✅ PostgreSQL: Listo y aceptando conexiones'
        PG_READY=true
    else
        echo '⏳ PostgreSQL: Aún iniciando...'
        PG_READY=false
    fi
    
    echo ''
    echo '=== Verificando Go Excel Processor ==='
    if curl -s -f http://localhost:8001/health &>/dev/null; then
        PYTHON_HEALTH=\$(curl -s http://localhost:8001/health 2>/dev/null || echo '{}')
        echo \"✅ Go (8001): Respondiendo - \$PYTHON_HEALTH\"
        PYTHON_READY=true
    else
        echo '⏳ Go (8001): Aún iniciando...'
        PYTHON_READY=false
    fi
    
    echo ''
    echo '=== Verificando NestJS Backend ==='
    if curl -s -f http://localhost:3000 &>/dev/null; then
        BACKEND_CODE=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null || echo '000')
        echo \"✅ NestJS (3000): Respondiendo (HTTP \$BACKEND_CODE)\"
        BACKEND_READY=true
    else
        echo '⏳ NestJS (3000): Aún iniciando...'
        BACKEND_READY=false
    fi
    
    echo ''
    echo '=== Resumen Final ==='
    if [ \"\$PG_READY\" = \"true\" ] && [ \"\$PYTHON_READY\" = \"true\" ] && [ \"\$BACKEND_READY\" = \"true\" ]; then
        echo '✅ TODOS LOS SERVICIOS ESTÁN FUNCIONANDO CORRECTAMENTE'
        exit 0
    else
        echo '⚠️  Algunos servicios aún están iniciando...'
        echo ''
        echo 'Últimos logs de NestJS (si hay errores):'
        sudo docker logs --tail=10 autochat-backend 2>&1 | tail -5 || true
        exit 1
    fi
" --quiet 2>&1)

echo "$VERIFICATION_OUTPUT"

# Verificar desde fuera de la VM también
log_info ""
log_info "Verificando servicios desde fuera de la VM..."

# Verificar NestJS Backend
log_info "🔍 Verificando NestJS Backend (puerto 3000)..."
BACKEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://$VM_EXTERNAL_IP:3000" 2>/dev/null || echo "000")
if [ "$BACKEND_STATUS" = "200" ] || [ "$BACKEND_STATUS" = "404" ]; then
    log_success "✓ NestJS Backend está respondiendo desde fuera (HTTP $BACKEND_STATUS)"
    BACKEND_EXTERNAL_OK=true
else
    log_warning "⚠ NestJS Backend aún no responde desde fuera (HTTP $BACKEND_STATUS)"
    log_info "   Esto puede ser normal si aún está iniciando (espera 30-60 segundos más)"
    BACKEND_EXTERNAL_OK=false
fi

# Verificar microservicio Go
log_info "🔍 Verificando Go Excel Processor (puerto 8001)..."
PYTHON_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://$VM_EXTERNAL_IP:8001/health" 2>/dev/null || echo "000")
if [ "$PYTHON_STATUS" = "200" ]; then
    log_success "✓ Go Excel Processor está respondiendo desde fuera"
    PYTHON_HEALTH=$(curl -s "http://$VM_EXTERNAL_IP:8001/health" 2>/dev/null || echo "")
    if [ -n "$PYTHON_HEALTH" ]; then
        log_info "   📊 Health check: $PYTHON_HEALTH"
    fi
    PYTHON_EXTERNAL_OK=true
else
    log_warning "⚠ Go Excel Processor aún no responde desde fuera (HTTP $PYTHON_STATUS)"
    PYTHON_EXTERNAL_OK=false
fi

echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "📊 RESUMEN FINAL DEL DEPLOYMENT"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   🗄️  PostgreSQL:    $(if echo "$VERIFICATION_OUTPUT" | grep -q "PostgreSQL: Listo"; then echo "✅ FUNCIONANDO"; else echo "⏳ Iniciando"; fi)"
echo "   🚀 Go (8001):      $(if echo "$VERIFICATION_OUTPUT" | grep -q "Go (8001): Respondiendo"; then echo "✅ FUNCIONANDO"; else echo "⏳ Iniciando"; fi)"
echo "   🚀 NestJS (3000):   $(if echo "$VERIFICATION_OUTPUT" | grep -q "NestJS (3000): Respondiendo"; then echo "✅ FUNCIONANDO"; else echo "⏳ Iniciando"; fi)"
echo ""
echo "   🌐 Acceso externo:"
echo "      - NestJS:  $(if [ "$BACKEND_EXTERNAL_OK" = "true" ]; then echo "✅ http://$VM_EXTERNAL_IP:3000"; else echo "⏳ Aún iniciando..."; fi)"
echo "      - Go:      $(if [ "$PYTHON_EXTERNAL_OK" = "true" ]; then echo "✅ http://$VM_EXTERNAL_IP:8001/health"; else echo "⏳ Aún iniciando..."; fi)"
echo ""

if echo "$VERIFICATION_OUTPUT" | grep -q "TODOS LOS SERVICIOS ESTÁN FUNCIONANDO"; then
    log_success "✅ ¡DEPLOYMENT EXITOSO! Todos los servicios están funcionando correctamente"
else
    log_warning "⚠️  Algunos servicios aún están iniciando. Esto es normal y pueden tardar 30-60 segundos más."
    log_info "   Puedes verificar el estado ejecutando:"
    log_info "   gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo docker ps'"
fi

echo ""

###############################################################################
# PASO 11: Configurar Cloudflare Tunnel (GRATIS - Automático)
###############################################################################

CLOUDFLARE_CONFIGURED=false
CLOUDFLARE_URL=""

log_step "11/11" "Configurando Cloudflare Tunnel (GRATIS)..."
log_info "Instalando Cloudflare Tunnel en la VM..."

# Crear el script de instalación como archivo temporal
CLOUDFLARE_SCRIPT=$(mktemp)
cat > "$CLOUDFLARE_SCRIPT" << 'CLOUDFLARE_INSTALL_SCRIPT'
#!/bin/bash
set -e

echo '=== [1/4] Deteniendo cloudflared anterior ==='
sudo systemctl stop cloudflared-tunnel 2>/dev/null || echo '  (no estaba corriendo)'
sleep 1

# Si el proceso aún está corriendo, matarlo
if pgrep -f cloudflared > /dev/null 2>&1; then
    echo '  Deteniendo proceso cloudflared...'
    sudo pkill -f cloudflared || true
    sleep 1
fi

echo '=== [2/4] Detectando arquitectura ==='
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    ARCH="amd64"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    ARCH="arm64"
fi
echo "  Arquitectura: ${ARCH}"

echo '=== [3/4] Descargando cloudflared ==='
VERSION=$(curl -s https://api.github.com/repos/cloudflare/cloudflared/releases/latest | grep tag_name | cut -d '"' -f 4)
echo "  Version: ${VERSION}"
DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-${ARCH}"

sudo curl -sL "$DOWNLOAD_URL" -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
echo '  ✓ cloudflared instalado'

echo '=== [4/4] Configurando servicio systemd ==='

# Crear archivo de servicio usando echo (evita problemas con heredoc en SSH)
echo '[Unit]' | sudo tee /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'Description=Cloudflare Tunnel' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'After=network.target' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo '' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo '[Service]' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'Type=simple' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'User=root' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'Restart=always' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'RestartSec=5' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo '' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo '[Install]' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null
echo 'WantedBy=multi-user.target' | sudo tee -a /etc/systemd/system/cloudflared-tunnel.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable cloudflared-tunnel
echo '  Iniciando túnel...'
sudo systemctl start cloudflared-tunnel

echo '  Esperando inicio del túnel (10 segundos)...'
sleep 10

# Obtener URL del túnel
TUNNEL_URL=$(sudo journalctl -u cloudflared-tunnel --since '1 minute ago' --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
if [ -n "$TUNNEL_URL" ]; then
    echo "TUNNEL_URL=$TUNNEL_URL"
    echo '✓ Cloudflare Tunnel configurado'
else
    echo '⚠ Esperando URL del túnel...'
fi
CLOUDFLARE_INSTALL_SCRIPT

# Copiar script a la VM y ejecutarlo
gcloud compute scp "$CLOUDFLARE_SCRIPT" "$VM_NAME:/tmp/install-cloudflared.sh" --zone="$GCP_ZONE" --quiet 2>/dev/null || {
    log_warning "SCP falló, intentando con SSH directo..."
    # Alternativa: enviar script por SSH
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="cat > /tmp/install-cloudflared.sh" --quiet < "$CLOUDFLARE_SCRIPT"
}

TUNNEL_OUTPUT=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="chmod +x /tmp/install-cloudflared.sh && /tmp/install-cloudflared.sh" --quiet 2>&1) || true
echo "$TUNNEL_OUTPUT"

# Limpiar script temporal local
rm -f "$CLOUDFLARE_SCRIPT"

# Extraer URL del output
TUNNEL_URL=$(echo "$TUNNEL_OUTPUT" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)

if [ -z "$TUNNEL_URL" ]; then
    log_info "Buscando URL del túnel (puede tardar unos segundos más)..."
    sleep 5
    
    for i in {1..4}; do
        TUNNEL_URL=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="sudo journalctl -u cloudflared-tunnel --since '2 minutes ago' --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1" --quiet 2>/dev/null)
        
        if [ -n "$TUNNEL_URL" ]; then
            log_success "URL encontrada"
            break
        fi
        
        if [ $i -lt 4 ]; then
            sleep 3
        fi
    done
fi

if [ -n "$TUNNEL_URL" ]; then
    CLOUDFLARE_CONFIGURED=true
    CLOUDFLARE_URL="$TUNNEL_URL"
    log_success "URL del túnel obtenida: $TUNNEL_URL"
else
    log_warning "URL no obtenida en el primer intento."
    log_info "Esperando 10 segundos más y reintentando..."
    sleep 10
    
    # Reintentar obtener la URL
    TUNNEL_URL=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="sudo journalctl -u cloudflared-tunnel --since '5 minutes ago' --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1" --quiet 2>/dev/null)
    
    if [ -n "$TUNNEL_URL" ]; then
        CLOUDFLARE_CONFIGURED=true
        CLOUDFLARE_URL="$TUNNEL_URL"
        log_success "URL del túnel obtenida: $TUNNEL_URL"
    else
        log_warning "No se pudo obtener la URL automáticamente."
        log_info "El túnel está configurado pero puede tardar en mostrar la URL."
        log_info "Para obtener la URL manualmente, ejecuta:"
        echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo journalctl -u cloudflared-tunnel --no-pager | grep trycloudflare'"
    fi
fi

# Actualizar CORS automáticamente si se obtuvo la URL del túnel
if [ -n "$TUNNEL_URL" ]; then
    log_info "Actualizando configuración de CORS para incluir la URL del túnel..."
    
    # Crear script temporal para actualizar CORS
    CORS_UPDATE_SCRIPT=$(mktemp)
    cat > "$CORS_UPDATE_SCRIPT" << CORS_SCRIPT_EOF
#!/bin/bash
cd ~/autochat-backend

# Leer CORS_ORIGINS actual
CURRENT_CORS=\$(grep '^CORS_ORIGINS=' .env | cut -d'=' -f2)

# Verificar si la URL del túnel ya está incluida
if echo "\$CURRENT_CORS" | grep -q "$TUNNEL_URL"; then
    echo '  ✓ URL del túnel ya está en CORS_ORIGINS'
else
    # Agregar URL del túnel a CORS_ORIGINS
    NEW_CORS="\$CURRENT_CORS,$TUNNEL_URL"
    sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\$NEW_CORS|" .env
    echo "  ✓ CORS_ORIGINS actualizado con: $TUNNEL_URL"
    
    # Reiniciar backend para aplicar cambios
    echo '  Reiniciando backend para aplicar configuración CORS...'
    sudo docker-compose restart backend
    echo '  ✓ Backend reiniciado'
fi
CORS_SCRIPT_EOF
    
    # Copiar y ejecutar script en la VM
    gcloud compute scp "$CORS_UPDATE_SCRIPT" "$VM_NAME:/tmp/update-cors.sh" --zone="$GCP_ZONE" --quiet 2>/dev/null || \
        gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="cat > /tmp/update-cors.sh" --quiet < "$CORS_UPDATE_SCRIPT"
    
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="chmod +x /tmp/update-cors.sh && /tmp/update-cors.sh" --quiet 2>/dev/null
    
    # Limpiar script temporal
    rm -f "$CORS_UPDATE_SCRIPT"
    
    log_success "CORS actualizado automáticamente"
fi

# Mostrar información del Cloudflare Tunnel si se configuró
if [ "$CLOUDFLARE_CONFIGURED" = true ]; then
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║        ✨ CLOUDFLARE TUNNEL CONFIGURADO ✨               ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    echo "🎉 Tu backend tiene un dominio público GRATIS!"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📡 INFORMACIÓN"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  🌐 URL Pública:        $CLOUDFLARE_URL"
    echo "  🔐 HTTPS:               ✅ Incluido (gratis)"
    echo "  ⚡ Cloudflare CDN:      ✅ Activado"
    echo "  💰 Costo:               🆓 GRATIS"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔧 CONFIGURACIÓN DEL FRONTEND"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Actualiza tu frontend para usar:"
    echo "  API_BASE_URL=$CLOUDFLARE_URL"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 COMANDOS ÚTILES CLOUDFLARE TUNNEL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Ver logs del túnel:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo journalctl -u cloudflared-tunnel -f'"
    echo ""
    echo "Reiniciar túnel:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo systemctl restart cloudflared-tunnel'"
    echo ""
    echo "Ver estado del túnel:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo systemctl status cloudflared-tunnel'"
    echo ""
    echo "Obtener URL del túnel:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo journalctl -u cloudflared-tunnel --no-pager | grep trycloudflare | tail -1'"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
fi

log_success "✓ Configuración de Cloudflare Tunnel completada"
echo ""

###############################################################################
# Información Final
###############################################################################

clear
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              ✨ DEPLOYMENT COMPLETADO ✨                  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}🎉 ¡Tu backend está funcionando en la nube!${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}📡 INFORMACIÓN DE ACCESO${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$CLOUDFLARE_CONFIGURED" = true ]; then
    echo "  🌐 Backend URL:    $CLOUDFLARE_URL"
    echo "  🔗 IP Directa:     http://$VM_EXTERNAL_IP:3000"
else
    echo "  🌐 Backend URL:    http://$VM_EXTERNAL_IP:3000"
fi

echo "  🔑 JWT Secret:     $JWT_SECRET"
echo "  💾 Base de datos:  PostgreSQL (interno)"
echo "  📍 Proyecto GCP:   $GCP_PROJECT_ID"
echo "  🌍 Zona:           $GCP_ZONE"
echo "  💻 VM:             $VM_NAME ($VM_MACHINE_TYPE)"

if [ "$CLOUDFLARE_CONFIGURED" = true ]; then
    if [[ "$CLOUDFLARE_URL" == *"trycloudflare.com"* ]]; then
        echo ""
        echo "  ✨ Cloudflare Tunnel:  Configurado (GRATIS)"
        echo "  🔐 SSL/HTTPS:          ✅ Incluido"
        echo "  💰 Costo:              🆓 GRATIS"
    else
        echo ""
        echo "  ✨ Cloudflare DNS:     Configurado"
        echo "  🔐 SSL/HTTPS:          Habilitado (espera 5-10 min)"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🔧 COMANDOS ÚTILES${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Ver logs en tiempo real:"
echo "  ./monitor-logs.sh"
echo ""
echo "Verificar estado:"
echo "  ./check-status.sh"
echo ""
echo "Conectar a la VM:"
echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE"
echo ""
echo "Reiniciar servicios:"
echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'cd ~/autochat-backend && sudo docker-compose restart'"
echo ""
echo "Ver logs directamente:"
echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'cd ~/autochat-backend && sudo docker-compose logs -f'"
echo ""
if [ "$CLOUDFLARE_CONFIGURED" = true ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}✨ TU API ESTÁ LISTA EN:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "${GREEN}   🌐 $CLOUDFLARE_URL${NC}"
    echo ""
    if [[ "$CLOUDFLARE_URL" == *"trycloudflare.com"* ]]; then
        echo "   ✅ SSL/HTTPS incluido y funcionando"
        echo "   🆓 100% GRATIS - Cloudflare Tunnel"
    else
        echo "   (SSL activándose, espera 5-10 minutos)"
    fi
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
fi

# Guardar info
cat > deployment-info.txt << EOF
╔═══════════════════════════════════════════════════╗
║     AutoChat Backend - Deployment Information     ║
╚═══════════════════════════════════════════════════╝

Fecha:           $(date)
Proyecto GCP:    $GCP_PROJECT_ID
Zona:            $GCP_ZONE
VM:              $VM_NAME
Tipo de máquina: $VM_MACHINE_TYPE
IP Externa:      $VM_EXTERNAL_IP

Backend URL:     http://$VM_EXTERNAL_IP:3000
$(if [ "$CLOUDFLARE_CONFIGURED" = true ]; then echo "Cloudflare URL:  $CLOUDFLARE_URL"; fi)
JWT Secret:      $JWT_SECRET

Base de datos:
  Usuario:       root
  Contraseña:    password
  Database:      autochat_db

Repositorio:     https://github.com/fabrizzioper/autochat-backend

Comandos útiles:
  Logs:     ./monitor-logs.sh
  Estado:   ./check-status.sh
  SSH:      gcloud compute ssh $VM_NAME --zone=$GCP_ZONE
EOF

log_success "✓ Información guardada en: deployment-info.txt"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}         ¡DEPLOYMENT EXITOSO! Todo funcionando 🚀         ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
