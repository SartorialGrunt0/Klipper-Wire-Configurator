#!/usr/bin/env bash
# Klipper Wire Configurator - One-Line Installer for Raspberry Pi (Raspbian Lite)
#
# Install with:
#   curl -sSL https://raw.githubusercontent.com/YOUR_USER/Klipper-Wire-Configurator/main/scripts/install.sh | bash
#
# Or if you've already cloned the repo:
#   bash scripts/install.sh
#
# Uninstall:
#   bash scripts/install.sh --uninstall

set -e

# --- Configuration ---
REPO_URL="https://github.com/YOUR_USER/Klipper-Wire-Configurator.git"
INSTALL_DIR="$HOME/klipper-wire-configurator"
SERVICE_NAME="klipper-wire-configurator"
KWC_PORT="${KWC_PORT:-8099}"
PYTHON_MIN_VERSION="3.9"
NODE_MIN_VERSION="18"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Uninstall ---
if [ "${1}" = "--uninstall" ]; then
    echo ""
    echo -e "${YELLOW}Uninstalling Klipper Wire Configurator...${NC}"
    echo ""

    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Stopping service..."
        systemctl --user stop "$SERVICE_NAME"
    fi
    if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Disabling service..."
        systemctl --user disable "$SERVICE_NAME"
    fi
    if [ -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service" ]; then
        info "Removing service file..."
        rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
        systemctl --user daemon-reload
    fi

    if [ -d "$INSTALL_DIR" ]; then
        info "Removing installation directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    ok "Klipper Wire Configurator has been uninstalled."
    echo ""
    exit 0
fi

# --- Banner ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Klipper Wire Configurator - Installer        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# --- Check architecture ---
ARCH="$(uname -m)"
info "Detected architecture: $ARCH"
if [[ "$ARCH" != "armv7l" && "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
    warn "Unexpected architecture: $ARCH. Proceeding anyway..."
fi

# --- Check OS ---
if [ -f /etc/os-release ]; then
    . /etc/os-release
    info "Detected OS: $PRETTY_NAME"
else
    warn "Could not detect OS. Proceeding anyway..."
fi

# --- Install system dependencies ---
info "Updating package lists..."
sudo apt-get update -qq

info "Installing system dependencies..."
sudo apt-get install -y -qq \
    python3 \
    python3-venv \
    python3-pip \
    git \
    curl \
    > /dev/null 2>&1
ok "System dependencies installed."

# --- Install Node.js if not present or too old ---
install_node() {
    info "Installing Node.js via NodeSource..."
    # Use NodeSource for a recent Node.js LTS
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
    sudo apt-get install -y -qq nodejs > /dev/null 2>&1
    ok "Node.js $(node --version) installed."
}

if command -v node &>/dev/null; then
    NODE_VER="$(node --version | sed 's/v//' | cut -d. -f1)"
    if [ "$NODE_VER" -lt "$NODE_MIN_VERSION" ]; then
        warn "Node.js version $(node --version) is too old (need >= $NODE_MIN_VERSION)."
        install_node
    else
        ok "Node.js $(node --version) found."
    fi
else
    install_node
fi

# --- Check Python version ---
PYTHON="python3"
PY_VER="$($PYTHON --version 2>&1 | sed 's/Python //' | cut -d. -f1,2)"
PY_MAJOR="$(echo "$PY_VER" | cut -d. -f1)"
PY_MINOR="$(echo "$PY_VER" | cut -d. -f2)"
REQ_MAJOR="$(echo "$PYTHON_MIN_VERSION" | cut -d. -f1)"
REQ_MINOR="$(echo "$PYTHON_MIN_VERSION" | cut -d. -f2)"

if [ "$PY_MAJOR" -lt "$REQ_MAJOR" ] || { [ "$PY_MAJOR" -eq "$REQ_MAJOR" ] && [ "$PY_MINOR" -lt "$REQ_MINOR" ]; }; then
    error "Python $PYTHON_MIN_VERSION+ is required, but found $PY_VER."
fi
ok "Python $PY_VER found."

# --- Clone or update repository ---
if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing installation found. Updating..."
    cd "$INSTALL_DIR"
    git fetch --quiet
    git reset --hard origin/main --quiet
    ok "Repository updated."
else
    if [ -d "$INSTALL_DIR" ]; then
        warn "Directory $INSTALL_DIR exists but is not a git repo. Backing up..."
        mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
    fi
    info "Cloning repository..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
    ok "Repository cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- Set up Python virtual environment ---
info "Setting up Python virtual environment..."
if [ ! -d "venv" ]; then
    $PYTHON -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate

info "Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r backend/requirements.txt
ok "Python dependencies installed."

deactivate

# --- Build frontend ---
info "Installing frontend dependencies..."
cd "$INSTALL_DIR/frontend"
npm ci --silent 2>/dev/null || npm install --silent
ok "Frontend dependencies installed."

info "Building frontend (this may take a few minutes on Raspberry Pi)..."
npm run build
ok "Frontend built successfully."

cd "$INSTALL_DIR"

# --- Create data directory for projects ---
mkdir -p "$INSTALL_DIR/data/projects"

# --- Install systemd user service ---
info "Setting up systemd service..."
mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Klipper Wire Configurator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
Environment=KWC_PORT=${KWC_PORT}
Environment=KWC_PROJECTS_DIR=${INSTALL_DIR}/data/projects
ExecStart=${INSTALL_DIR}/venv/bin/uvicorn main:app --host 0.0.0.0 --port ${KWC_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

# Enable lingering so the user service starts at boot without login
sudo loginctl enable-linger "$USER" 2>/dev/null || true

ok "Service installed and started."

# --- Wait for service to come up ---
info "Waiting for service to start..."
for i in $(seq 1 15); do
    if curl -sf "http://localhost:${KWC_PORT}/health" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

if curl -sf "http://localhost:${KWC_PORT}/health" > /dev/null 2>&1; then
    ok "Service is running!"
else
    warn "Service may still be starting. Check with: systemctl --user status $SERVICE_NAME"
fi

# --- Get IP address ---
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="<your-pi-ip>"
fi

# --- Done! ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Installation Complete!                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Open in your browser:"
echo -e "    ${BLUE}http://${IP_ADDR}:${KWC_PORT}${NC}"
echo ""
echo -e "  Manage the service:"
echo -e "    Status:  ${YELLOW}systemctl --user status ${SERVICE_NAME}${NC}"
echo -e "    Stop:    ${YELLOW}systemctl --user stop ${SERVICE_NAME}${NC}"
echo -e "    Start:   ${YELLOW}systemctl --user start ${SERVICE_NAME}${NC}"
echo -e "    Logs:    ${YELLOW}journalctl --user -u ${SERVICE_NAME} -f${NC}"
echo ""
echo -e "  Update:    ${YELLOW}cd ${INSTALL_DIR} && bash scripts/install.sh${NC}"
echo -e "  Uninstall: ${YELLOW}bash ${INSTALL_DIR}/scripts/install.sh --uninstall${NC}"
echo ""
echo -e "  Project files are stored in: ${INSTALL_DIR}/data/projects"
echo ""
