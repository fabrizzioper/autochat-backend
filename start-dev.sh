#!/bin/bash

# Script para iniciar NestJS y Python en DOS terminales separadas
# Primero Python, luego NestJS (si Python inicia correctamente)

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
    tmux new-session -d -s autochat-dev -n python
    
    # Configurar Python
    tmux send-keys -t autochat-dev:python "cd $(pwd)/excel-processor-service" C-m
    tmux send-keys -t autochat-dev:python "if [ ! -d 'venv' ]; then python3 -m venv venv; fi" C-m
    tmux send-keys -t autochat-dev:python "source venv/bin/activate" C-m
    tmux send-keys -t autochat-dev:python "pip install --upgrade pip > /dev/null 2>&1" C-m
    tmux send-keys -t autochat-dev:python "pip install -r requirements.txt" C-m
    tmux send-keys -t autochat-dev:python "if [ -f '../.env' ]; then export \$(cat '../.env' | grep -v '^#' | xargs); fi" C-m
    tmux send-keys -t autochat-dev:python "echo '✅ Python iniciando en http://localhost:8001'" C-m
    tmux send-keys -t autochat-dev:python "python main.py" C-m
    
    # Esperar a que Python inicie
    echo "⏳ Esperando a que Python inicie (5 segundos)..."
    sleep 5
    
    # Verificar que Python esté corriendo
    if ! curl -s http://localhost:8001/health > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Python aún no responde, esperando más tiempo...${NC}"
        sleep 5
    fi
    
    if curl -s http://localhost:8001/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Python iniciado correctamente${NC}"
        
        # Crear ventana NestJS
        tmux new-window -t autochat-dev -n nestjs
        tmux send-keys -t autochat-dev:nestjs "cd $(pwd)" C-m
        tmux send-keys -t autochat-dev:nestjs "echo '✅ NestJS iniciando en http://localhost:3000'" C-m
        tmux send-keys -t autochat-dev:nestjs "npm run start:dev:nestjs" C-m
        
        echo ""
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${GREEN}✅ Servicios iniciados en tmux:${NC}"
        echo -e "   Sesión: ${YELLOW}autochat-dev${NC}"
        echo -e "   🐍 Python:  ventana 'python' (puerto 8001) ✅"
        echo -e "   ⚡ NestJS:  ventana 'nestjs' (puerto 3000)"
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo "Comandos:"
        echo "  tmux attach -t autochat-dev"
        echo "  Ctrl+B luego 0 = Python, Ctrl+B luego 1 = NestJS"
        echo ""
        
        if [ -z "$TMUX" ]; then
            sleep 1
            tmux attach -t autochat-dev
        fi
    else
        echo -e "${RED}❌ Python no pudo iniciar. Revisa los logs en tmux.${NC}"
        echo "  tmux attach -t autochat-dev"
        exit 1
    fi
    
    exit 0
fi

# Para local: DOS terminales separadas
echo -e "${GREEN}🐍 [1/2] Abriendo terminal para Python...${NC}"

# Matar procesos anteriores de Python en el puerto 8001
if lsof -ti:8001 > /dev/null 2>&1; then
    echo "🛑 Deteniendo proceso anterior de Python en puerto 8001..."
    lsof -ti:8001 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Matar procesos anteriores de NestJS en el puerto 3000
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "🛑 Deteniendo proceso anterior de NestJS en puerto 3000..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Script para Python
PYTHON_SCRIPT=$(mktemp)
cat > "$PYTHON_SCRIPT" << 'PYEOF'
#!/bin/bash
cd excel-processor-service

# Crear venv si no existe
if [ ! -d "venv" ]; then
    echo "📦 Creando entorno virtual..."
    python3 -m venv venv
fi

# Activar e instalar
source venv/bin/activate
pip install --upgrade pip > /dev/null 2>&1
pip install -r requirements.txt

# Cargar .env
if [ -f "../.env" ]; then
    export $(cat "../.env" | grep -v '^#' | xargs)
fi

echo "✅ Python iniciando en http://localhost:8001"
python main.py
PYEOF

chmod +x "$PYTHON_SCRIPT"

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
    echo "Abriendo terminal para Python..."
    osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$(pwd)' && bash '$PYTHON_SCRIPT'"
end tell
EOF
    
    # Esperar a que Python inicie
    echo "⏳ Esperando a que Python inicie (5 segundos)..."
    sleep 5
    
    # Verificar que Python esté corriendo
    MAX_RETRIES=6
    RETRY_COUNT=0
    PYTHON_READY=false
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -s http://localhost:8001/health > /dev/null 2>&1; then
            PYTHON_READY=true
            break
        fi
        RETRY_COUNT=$((RETRY_COUNT + 1))
        sleep 2
    done
    
    if [ "$PYTHON_READY" = false ]; then
        echo -e "${RED}❌ Python no responde después de $((MAX_RETRIES * 2)) segundos${NC}"
        echo "Revisa la terminal de Python para ver errores"
        rm -f "$PYTHON_SCRIPT" "$NESTJS_SCRIPT"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Python iniciado correctamente${NC}"
    echo ""
    echo -e "${GREEN}⚡ [2/2] Abriendo terminal para NestJS...${NC}"
    
    # Abrir segunda terminal para NestJS
    osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$(pwd)' && bash '$NESTJS_SCRIPT'"
end tell
EOF
    
    echo ""
    echo -e "${GREEN}✅ DOS terminales abiertas:${NC}"
    echo -e "   🐍 Python:  http://localhost:8001 (Terminal 1)"
    echo -e "   ⚡ NestJS:  http://localhost:3000 (Terminal 2)"
    
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v gnome-terminal &> /dev/null; then
        echo "Abriendo terminal para Python..."
        gnome-terminal --title="Python (8001)" -- bash -c "cd '$(pwd)' && bash '$PYTHON_SCRIPT'; exec bash" &
        
        # Esperar a que Python inicie
        echo "⏳ Esperando a que Python inicie (5 segundos)..."
        sleep 5
        
        # Verificar
        MAX_RETRIES=6
        RETRY_COUNT=0
        PYTHON_READY=false
        
        while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
            if curl -s http://localhost:8001/health > /dev/null 2>&1; then
                PYTHON_READY=true
                break
            fi
            RETRY_COUNT=$((RETRY_COUNT + 1))
            sleep 2
        done
        
        if [ "$PYTHON_READY" = false ]; then
            echo -e "${RED}❌ Python no responde${NC}"
            rm -f "$PYTHON_SCRIPT" "$NESTJS_SCRIPT"
            exit 1
        fi
        
        echo -e "${GREEN}✅ Python iniciado correctamente${NC}"
        echo ""
        echo -e "${GREEN}⚡ Abriendo terminal para NestJS...${NC}"
        
        gnome-terminal --title="NestJS (3000)" -- bash -c "cd '$(pwd)' && bash '$NESTJS_SCRIPT'; exec bash" &
        
        echo ""
        echo -e "${GREEN}✅ DOS terminales abiertas:${NC}"
        echo -e "   🐍 Python:  http://localhost:8001"
        echo -e "   ⚡ NestJS:  http://localhost:3000"
    else
        # Fallback: usar tmux
        echo -e "${YELLOW}⚠️  No se encontró terminal GUI, usando tmux...${NC}"
        USE_TMUX=true
    fi
else
    # Fallback: usar tmux
    echo -e "${YELLOW}⚠️  Sistema no soportado, usando tmux...${NC}"
    USE_TMUX=true
fi

# Limpiar scripts temporales después de un tiempo
(sleep 10 && rm -f "$PYTHON_SCRIPT" "$NESTJS_SCRIPT") &
