#!/usr/bin/env bash
# ==============================================================================
# Undermania — Script de Lanzamiento para Arch Linux
# ==============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PORT="${PORT:-8080}"
URL="http://127.0.0.1:${PORT}"

# Colores en terminal (inspirados en #00FFFF, #6C439C, #BD8FCC)
CYAN='\033[1;36m'
PURPLE='\033[1;35m'
LAVENDER='\033[0;35m'
GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'

echo -e "${CYAN}==============================================================${NC}"
echo -e "${CYAN}   🎹 UNDERMANIA — Laboratorio Universitario de Piano         ${NC}"
echo -e "${PURPLE}   Lector Interactivo MIDI (.mid) & Partituras (.mscz)        ${NC}"
echo -e "${CYAN}==============================================================${NC}"

# 1. Verificar Python 3 en Arch Linux
if ! command -v python3 &>/dev/null; then
    echo -e "${LAVENDER}[INFO] Python 3 no encontrado. Instalando con pacman...${NC}"
    sudo pacman -S --needed --noconfirm python
fi

# 2. Generar archivos de prueba (.mid y .mscz) si no existen
if [[ ! -d "$PROJECT_DIR/samples" ]] || [[ -z "$(ls -A "$PROJECT_DIR/samples" 2>/dev/null)" ]]; then
    echo -e "${LAVENDER}[INFO] Generando repertorio de ejemplo (.mid y .mscz)...${NC}"
    python3 "$PROJECT_DIR/generate_samples.py"
fi

# 3. Liberar el puerto si una instancia previa quedó activa
if command -v fuser &>/dev/null; then
    fuser -k "${PORT}/tcp" &>/dev/null || true
fi

# 4. Iniciar el servidor en segundo plano y asegurar limpieza al salir
cleanup() {
    echo -e "\n${LAVENDER}[INFO] Cerrando servidor de Undermania...${NC}"
    if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

echo -e "${GREEN}[OK] Iniciando servidor local en ${URL}${NC}"
PORT="$PORT" python3 "$PROJECT_DIR/server.py" &
SERVER_PID=$!

# Esperar brevemente a que el servidor esté listo
sleep 0.8

# 5. Abrir el navegador automáticamente (priorizando navegadores con soporte WebMIDI)
echo -e "${LAVENDER}[INFO] Abriendo interfaz de Undermania...${NC}"
if command -v chromium &>/dev/null; then
    chromium --app="$URL" &>/dev/null &
elif command -v google-chrome-stable &>/dev/null; then
    google-chrome-stable --app="$URL" &>/dev/null &
elif command -v brave &>/dev/null; then
    brave --app="$URL" &>/dev/null &
elif command -v xdg-open &>/dev/null; then
    xdg-open "$URL" &>/dev/null &
else
    echo -e "${CYAN}Abre manualmente en tu navegador: ${URL}${NC}"
fi

echo -e "${CYAN}Presiona Ctrl+C para detener Undermania.${NC}"
wait "$SERVER_PID"
