#!/bin/bash

# Script para iniciar NestJS y Go Excel Processor en DOS terminales separadas
# Primero Go, luego NestJS (si Go inicia correctamente)

# Colores
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🚀 Iniciando servicios en DOS terminales separadas...${NC}"
echo ""

# Detectar si estamos en VM (SSH o sin DISPLAY)
if [ -z "$DISPLAY" ] || [ -n "$SSH_CONNECTION" ]; then
    USE_TMUX=true
else
    USE_TMUX=false
fi

# Si tmux está disponible y estamos en VM, usarlo
if [ "$USE_TMUX" = true ] && command -v tmux &> /dev/null; then
    echo -e "${GREEN}Usando tmux (una consola, dos ventanas)...${NC}"
    
    # Matar sesión anterior
    tmux kill-session -t autochat-dev 2>/dev/null || true
    sleep 1
    
    # Crear sesión
    tmux new-session -d -s autochat-dev -n excel-go
    
    # Configurar Go
    tmux send-keys -t autochat-dev:excel-go "cd $(pwd)/excel-processor-go" C-m
    tmux send-keys -t autochat-dev:excel-go "if [ -f '../.env' ]; then export \$(cat '../.env' | grep -v '^#' | xargs); fi" C-m
    tmux send-keys -t autochat-dev:excel-go "echo '✅ Excel Processor (Go) iniciando en http://localhost:8001'" C-m
    tmux send-keys -t autochat-dev:excel-go "go run ." C-m
    
    # Esperar a que Go inicie
    echo "⏳ Esperando a que Go inicie (5 segundos)..."
    sleep 5
    
    # Verificar que Go esté corriendo
    if ! curl -s http://localhost:8001/health > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Go aún no responde, esperando más tiempo...${NC}"
        sleep 5
    fi
    
    if curl -s http://localhost:8001/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Go Excel Processor iniciado correctamente${NC}"
        
        # Crear ventana NestJS
        tmux new-window -t autochat-dev -n nestjs
        tmux send-keys -t autochat-dev:nestjs "cd $(pwd)" C-m
        tmux send-keys -t autochat-dev:nestjs "echo '✅ NestJS iniciando en http://localhost:3000'" C-m
        tmux send-keys -t autochat-dev:nestjs "npm run start:dev:nestjs" C-m
        
        echo ""
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${GREEN}✅ Servicios iniciados en tmux:${NC}"
        echo -e "   Sesión: ${YELLOW}autochat-dev${NC}"
        echo -e "   🚀 Go:      ventana 'excel-go' (puerto 8001) ✅"
        echo -e "   ⚡ NestJS:  ventana 'nestjs' (puerto 3000)"
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo "Comandos:"
        echo "  tmux attach -t autochat-dev"
        echo "  Ctrl+B luego 0 = Go, Ctrl+B luego 1 = NestJS"
        echo ""
        
        if [ -z "$TMUX" ]; then
            sleep 1
            tmux attach -t autochat-dev
        fi
    else
        echo -e "${RED}❌ Go no pudo iniciar. Revisa los logs en tmux.${NC}"
        echo "  tmux attach -t autochat-dev"
        exit 1
    fi
    
    exit 0
fi

# Para local: DOS terminales separadas
echo -e "${GREEN}🚀 [1/2] Abriendo terminal para Go Excel Processor...${NC}"

# Matar procesos anteriores en el puerto 8001
if lsof -ti:8001 > /dev/null 2>&1; then
    echo "🛑 Deteniendo proceso anterior en puerto 8001..."
    lsof -ti:8001 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Matar procesos anteriores de NestJS en el puerto 3000
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "🛑 Deteniendo proceso anterior de NestJS en puerto 3000..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Script para Go
GO_SCRIPT=$(mktemp)
cat > "$GO_SCRIPT" << 'GOEOF'
#!/bin/bash
cd excel-processor-go

# Cargar .env
if [ -f "../.env" ]; then
    export $(cat "../.env" | grep -v '^#' | xargs)
fi

echo "✅ Excel Processor (Go) iniciando en http://localhost:8001"
go run .
GOEOF

chmod +x "$GO_SCRIPT"

# Script para NestJS
NESTJS_SCRIPT=$(mktemp)
cat > "$NESTJS_SCRIPT" << 'NESTEOF'
#!/bin/bash
echo "✅ NestJS iniciando en http://localhost:3000"
npm run start:dev:nestjs
NESTEOF

chmod +x "$NESTJS_SCRIPT"

# Abrir DOS terminales separadas según el OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - abrir DOS ventanas de Terminal separadas
    echo "Abriendo terminal para Go Excel Processor..."
    osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$(pwd)' && bash '$GO_SCRIPT'"
end tell
EOF
    
    # Esperar a que Go inicie
    echo "⏳ Esperando a que Go inicie (5 segundos)..."
    sleep 5
    
    # Verificar que Go esté corriendo
    MAX_RETRIES=6
    RETRY_COUNT=0
    GO_READY=false
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -s http://localhost:8001/health > /dev/null 2>&1; then
            GO_READY=true
            break
        fi
        RETRY_COUNT=$((RETRY_COUNT + 1))
        sleep 2
    done
    
    if [ "$GO_READY" = false ]; then
        echo -e "${RED}❌ Go no responde después de $((MAX_RETRIES * 2)) segundos${NC}"
        echo "Revisa la terminal de Go para ver errores"
        rm -f "$GO_SCRIPT" "$NESTJS_SCRIPT"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Go Excel Processor iniciado correctamente${NC}"
    echo ""
    echo -e "${GREEN}⚡ [2/2] Abriendo terminal para NestJS...${NC}"
    
    osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$(pwd)' && bash '$NESTJS_SCRIPT'"
end tell
EOF
    
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}✅ Se abrieron DOS terminales:${NC}"
    echo -e "   🚀 Terminal 1: Go Excel Processor (puerto 8001) ✅"
    echo -e "   ⚡ Terminal 2: NestJS (puerto 3000)"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Los scripts temporales se limpiarán automáticamente cuando cierres las terminales"

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux con entorno gráfico
    if command -v gnome-terminal &> /dev/null; then
        echo "Abriendo terminal para Go..."
        gnome-terminal --title="Go Excel Processor" -- bash -c "cd '$(pwd)' && bash '$GO_SCRIPT'; exec bash"
        
        # Esperar a que Go inicie
        echo "⏳ Esperando a que Go inicie (5 segundos)..."
        sleep 5
        
        # Verificar que Go esté corriendo
        if curl -s http://localhost:8001/health > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Go Excel Processor iniciado correctamente${NC}"
            echo -e "${GREEN}⚡ [2/2] Abriendo terminal para NestJS...${NC}"
            gnome-terminal --title="NestJS" -- bash -c "cd '$(pwd)' && bash '$NESTJS_SCRIPT'; exec bash"
        else
            echo -e "${RED}❌ Go no responde. Revisa la terminal de Go para ver errores${NC}"
            rm -f "$GO_SCRIPT" "$NESTJS_SCRIPT"
            exit 1
        fi
        
    elif command -v xterm &> /dev/null; then
        echo "Abriendo terminal para Go..."
        xterm -T "Go Excel Processor" -e "cd '$(pwd)' && bash '$GO_SCRIPT'; exec bash" &
        
        sleep 5
        
        if curl -s http://localhost:8001/health > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Go iniciado correctamente${NC}"
            xterm -T "NestJS" -e "cd '$(pwd)' && bash '$NESTJS_SCRIPT'; exec bash" &
        else
            echo -e "${RED}❌ Go no responde${NC}"
            rm -f "$GO_SCRIPT" "$NESTJS_SCRIPT"
            exit 1
        fi
    else
        echo -e "${YELLOW}⚠️ No se encontró terminal gráfica. Usando tmux...${NC}"
        USE_TMUX=true
    fi
    
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}✅ Se abrieron DOS terminales:${NC}"
    echo -e "   🚀 Terminal 1: Go Excel Processor (puerto 8001)"
    echo -e "   ⚡ Terminal 2: NestJS (puerto 3000)"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi
