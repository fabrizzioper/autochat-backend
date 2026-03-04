#!/bin/bash

###############################################################################
# Script para Configurar Cloudflare Tunnel (GRATIS)
# Da un dominio público tipo: xyz.trycloudflare.com
###############################################################################

set -e

# Colores
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

# Banner
clear
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║       🌐 Cloudflare Tunnel - Dominio Público GRATIS      ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

###############################################################################
# Obtener información del deployment
###############################################################################

if [ ! -f "deployment-info.txt" ]; then
    log_error "No se encuentra deployment-info.txt"
    log_info "Primero ejecuta: ./deploy-gcp.sh"
    exit 1
fi

# Extraer información
VM_NAME=$(grep "VM:" deployment-info.txt | awk '{print $2}')
GCP_ZONE=$(grep "Zona:" deployment-info.txt | awk '{print $2}')

if [ -z "$VM_NAME" ] || [ -z "$GCP_ZONE" ]; then
    log_error "No se pudo obtener información de la VM"
    log_info "Verifica deployment-info.txt"
    exit 1
fi

log_success "VM encontrada: $VM_NAME en zona $GCP_ZONE"
echo ""

###############################################################################
# Instalar Cloudflare Tunnel en la VM
###############################################################################

log_info "Instalando Cloudflare Tunnel en la VM..."
log_info "Esto puede tardar 1-2 minutos..."
echo ""

gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="
    set -e
    
    echo '=== [1/3] Descargando cloudflared ==='
    
    # Detectar arquitectura
    ARCH=\$(uname -m)
    if [ \"\$ARCH\" = \"x86_64\" ]; then
        ARCH=\"amd64\"
    elif [ \"\$ARCH\" = \"aarch64\" ] || [ \"\$ARCH\" = \"arm64\" ]; then
        ARCH=\"arm64\"
    fi
    
    # Descargar última versión
    VERSION=\$(curl -s https://api.github.com/repos/cloudflare/cloudflared/releases/latest | grep tag_name | cut -d '\"' -f 4)
    DOWNLOAD_URL=\"https://github.com/cloudflare/cloudflared/releases/download/\${VERSION}/cloudflared-linux-\${ARCH}\"
    
    sudo curl -L \"\$DOWNLOAD_URL\" -o /usr/local/bin/cloudflared
    sudo chmod +x /usr/local/bin/cloudflared
    
    echo '=== [2/3] Creando servicio systemd ==='
    
    # Crear servicio systemd para el túnel
    sudo tee /etc/systemd/system/cloudflared-tunnel.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEEOF
    
    echo '=== [3/3] Iniciando túnel ==='
    
    # Detener si ya está corriendo
    sudo systemctl stop cloudflared-tunnel 2>/dev/null || true
    
    # Recargar systemd
    sudo systemctl daemon-reload
    
    # Habilitar y iniciar
    sudo systemctl enable cloudflared-tunnel
    sudo systemctl start cloudflared-tunnel
    
    # Esperar a que se inicie
    sleep 5
    
    # Obtener la URL del túnel (está en los logs)
    TUNNEL_URL=\$(sudo journalctl -u cloudflared-tunnel -n 50 --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
    
    if [ -n \"\$TUNNEL_URL\" ]; then
        echo \"TUNNEL_URL=\$TUNNEL_URL\"
    else
        echo 'Esperando URL del túnel...'
        sleep 10
        TUNNEL_URL=\$(sudo journalctl -u cloudflared-tunnel -n 100 --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
        echo \"TUNNEL_URL=\$TUNNEL_URL\"
    fi
    
    echo '✓ Cloudflare Tunnel configurado'
" --quiet

# Intentar obtener la URL del túnel
log_info "Obteniendo URL del túnel..."

TUNNEL_URL=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="
    sudo journalctl -u cloudflared-tunnel -n 200 --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
" --quiet 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)

# Si no se obtiene, intentar de otra forma
if [ -z "$TUNNEL_URL" ]; then
    log_warning "Obteniendo URL (puede tardar unos segundos más)..."
    sleep 10
    TUNNEL_URL=$(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="
        sudo journalctl -u cloudflared-tunnel --since '1 minute ago' --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
    " --quiet 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
fi

if [ -z "$TUNNEL_URL" ]; then
    log_warning "No se pudo obtener la URL automáticamente"
    log_info "Revisando logs del túnel..."
    
    # Mostrar últimos logs
    gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --command="
        sudo journalctl -u cloudflared-tunnel -n 30 --no-pager
    " --quiet
    
    echo ""
    log_info "Por favor, ejecuta esto para ver la URL:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo journalctl -u cloudflared-tunnel -f'"
    echo ""
    log_info "La URL aparecerá en los logs como: https://xyz.trycloudflare.com"
else
    log_success "URL del túnel obtenida: $TUNNEL_URL"
fi

###############################################################################
# Resultado
###############################################################################

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║        ✨ CLOUDFLARE TUNNEL CONFIGURADO ✨               ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

if [ -n "$TUNNEL_URL" ]; then
    echo -e "${GREEN}🎉 Tu backend tiene un dominio público GRATIS!${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}📡 INFORMACIÓN${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "  🌐 URL Pública:        ${GREEN}$TUNNEL_URL${NC}"
    echo "  🔐 HTTPS:               ✅ Incluido (gratis)"
    echo "  ⚡ Cloudflare CDN:      ✅ Activado"
    echo "  💰 Costo:               🆓 GRATIS"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}🔧 CONFIGURACIÓN DEL FRONTEND${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Actualiza tu frontend para usar:"
    echo -e "  ${YELLOW}API_BASE_URL=$TUNNEL_URL${NC}"
    echo ""
    
    # Actualizar deployment-info.txt
    if [ -f "deployment-info.txt" ]; then
        if grep -q "Cloudflare Tunnel URL:" deployment-info.txt; then
            sed -i.bak "s|Cloudflare Tunnel URL:.*|Cloudflare Tunnel URL: $TUNNEL_URL|" deployment-info.txt
        else
            echo "" >> deployment-info.txt
            echo "Cloudflare Tunnel URL: $TUNNEL_URL" >> deployment-info.txt
            echo "Tunnel configurado:    $(date)" >> deployment-info.txt
        fi
        log_success "deployment-info.txt actualizado"
    fi
else
    echo -e "${YELLOW}⚠️  Túnel configurado pero URL no obtenida automáticamente${NC}"
    echo ""
    echo "Para ver la URL ejecuta:"
    echo "  gcloud compute ssh $VM_NAME --zone=$GCP_ZONE -- 'sudo journalctl -u cloudflared-tunnel -n 50'"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}📋 COMANDOS ÚTILES${NC}"
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
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -n "$TUNNEL_URL" ]; then
    log_success "✓ Configuración completada"
    echo ""
    log_info "🚀 Tu backend está disponible públicamente en:"
    echo -e "   ${GREEN}$TUNNEL_URL${NC}"
    echo ""
fi













