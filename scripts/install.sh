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

set -Eeuo pipefail

# --- Configuration ---
REPO_URL="https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git"
INSTALL_DIR="$HOME/klipper-wire-configurator"
SERVICE_NAME="klipper-wire-configurator"
KWC_PORT="${KWC_PORT:-8099}"
KWC_GIT_REF="${KWC_GIT_REF:-}"
PYTHON_MIN_VERSION="3.10"
NODE_MIN_VERSION="18"
LOG_DIR="${TMPDIR:-/tmp}"
LOG_FILE="${LOG_DIR}/klipper-wire-configurator-install-$(date +%Y%m%d-%H%M%S).log"
SYSTEM_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LEGACY_USER_SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"

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

is_legacy_user_service_active() {
    systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null
}

is_system_service_active() {
    sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null
}

# Detect Mainsail so we can drop a sidebar link to KWC in its theme folder.
# Fluidd and OctoPrint have no custom-navigation equivalent, so navi.json is
# only written when Mainsail is actually present.
mainsail_installed() {
    if [ -d "$HOME/mainsail" ]; then
        return 0
    fi
    local moonraker_conf
    for moonraker_conf in "$HOME/printer_data/config/moonraker.conf" "$HOME/klipper_config/moonraker.conf"; do
        if [ -f "$moonraker_conf" ] && grep -q '^\[update_manager mainsail\]' "$moonraker_conf"; then
            return 0
        fi
    done
    return 1
}

# Locate Mainsail's .theme folder (inside the Klipper/Moonraker config dir).
# Prefers an existing .theme folder; falls back to creating one in the
# detected config directory.
resolve_mainsail_theme_dir() {
    if [ -d "$HOME/printer_data/config/.theme" ]; then
        echo "$HOME/printer_data/config/.theme"
        return 0
    fi
    if [ -d "$HOME/klipper_config/.theme" ]; then
        echo "$HOME/klipper_config/.theme"
        return 0
    fi
    if [ -d "$HOME/printer_data/config" ]; then
        echo "$HOME/printer_data/config/.theme"
        return 0
    fi
    if [ -d "$HOME/klipper_config" ]; then
        echo "$HOME/klipper_config/.theme"
        return 0
    fi
    return 1
}

# Locate the Moonraker config directory (kiauh layout). Used for the
# update_manager include file and Mainsail's .theme folder.
resolve_moonraker_config_dir() {
    if [ -d "$HOME/printer_data/config" ]; then
        echo "$HOME/printer_data/config"
        return 0
    fi
    if [ -d "$HOME/klipper_config" ]; then
        echo "$HOME/klipper_config"
        return 0
    fi
    return 1
}

# Write a file, escalating to sudo when the current user lacks write access
# (the Moonraker config dir is sometimes root-owned). Ownership is returned
# to the invoking user so moonraker/Mainsail can keep managing the file.
write_file_elevated() {
    local target="$1" content="$2"
    if printf '%s' "$content" > "$target" 2>/dev/null; then
        return 0
    fi
    warn "No write access to $target, retrying with sudo..."
    if printf '%s' "$content" | sudo tee "$target" > /dev/null 2>&1; then
        sudo chown "$USER" "$target" 2>/dev/null || true
        return 0
    fi
    warn "Could not write $target (permission denied). Skipping."
    return 1
}

# Append a line to a file, escalating to sudo when needed.
append_line_elevated() {
    local target="$1" line="$2"
    if printf '%s\n' "$line" >> "$target" 2>/dev/null; then
        return 0
    fi
    warn "No write access to $target, retrying with sudo..."
    if printf '%s\n' "$line" | sudo tee -a "$target" > /dev/null 2>&1; then
        return 0
    fi
    warn "Could not append to $target (permission denied). Skipping."
    return 1
}

# Add KWC to Moonraker's update manager so updates show up in Mainsail /
# Fluidd. Writes a dedicated include file (same pattern as obico's
# moonraker-obico-update.cfg) and adds a single [include] line to
# moonraker.conf — the user's other sections are left untouched. Best-effort:
# failures warn and return 0 so the install never aborts over this.
install_moonraker_updater() {
    local config_dir moonraker_conf include_file content
    config_dir="$(resolve_moonraker_config_dir)" || return 0
    moonraker_conf="$config_dir/moonraker.conf"
    [ -f "$moonraker_conf" ] || return 0
    include_file="$config_dir/klipper-wire-configurator-update.cfg"

    # If the user manages KWC directly in moonraker.conf, don't duplicate.
    if grep -q '^\[update_manager klipper-wire-configurator\]' "$moonraker_conf"; then
        return 0
    fi

    content="$(
        echo "[update_manager klipper-wire-configurator]"
        echo "type: git_repo"
        echo "channel: dev"
        echo "path: $INSTALL_DIR"
        echo "origin: $REPO_URL"
        echo "primary_branch: main"
        echo "virtualenv: $INSTALL_DIR/venv"
        echo "requirements: backend/requirements.txt"
        echo "managed_services: klipper-wire-configurator"
        echo "info_tags:"
        printf '\tdesc=Klipper Wire Configurator\n'
    )"
    write_file_elevated "$include_file" "$content" || return 0

    if ! grep -q '^\[include klipper-wire-configurator-update\.cfg\]' "$moonraker_conf"; then
        append_line_elevated "$moonraker_conf" "" || true
        append_line_elevated "$moonraker_conf" "[include klipper-wire-configurator-update.cfg]" || true
    fi
    return 0
}

# Remove the KWC update_manager include (file + include line) from the
# Moonraker config directory. Best-effort.
remove_moonraker_updater() {
    local config_dir moonraker_conf include_file
    config_dir="$(resolve_moonraker_config_dir)" || return 0
    moonraker_conf="$config_dir/moonraker.conf"
    include_file="$config_dir/klipper-wire-configurator-update.cfg"

    rm -f "$include_file" 2>/dev/null || true
    if [ -f "$moonraker_conf" ]; then
        if ! sed -i '/^\[include klipper-wire-configurator-update\.cfg\]$/d' "$moonraker_conf" 2>/dev/null; then
            sudo sed -i '/^\[include klipper-wire-configurator-update\.cfg\]$/d' "$moonraker_conf" 2>/dev/null || true
        fi
    fi
    return 0
}

# Merge (or remove) the KWC entry in Mainsail's navi.json. Keeps any other
# custom navigation entries the user already has. Best-effort: failures warn
# and return 0 so the install never aborts over this.
edit_mainsail_navi() {
    local action="$1"  # add | remove
    local theme_dir navi_path kwc_url py_script
    theme_dir="$(resolve_mainsail_theme_dir)" || return 0
    if ! mkdir -p "$theme_dir" 2>/dev/null; then
        sudo mkdir -p "$theme_dir" 2>/dev/null || return 0
    fi
    navi_path="$theme_dir/navi.json"
    kwc_url="http://${IP_ADDR:-localhost}:${KWC_PORT}"

    py_script="$(mktemp)"
    cat > "$py_script" <<'PYEOF'
import json
import sys

action, path, url = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(path, encoding="utf-8") as fh:
        entries = json.load(fh)
    if not isinstance(entries, list):
        entries = []
except (OSError, ValueError):
    entries = []

entries = [
    e for e in entries
    if not (isinstance(e, dict) and e.get("title") == "KWC")
]

if action == "add":
    # KWC favicon mark (frontend/public/favicon.svg) converted to a single
    # filled SVG path: the 4-spoke asterisk + tip dots, background square
    # dropped (nav icons render monochrome with the sidebar text color).
    entries.append({
        "title": "KWC",
        "href": url,
        "target": "_blank",
        "position": 95,
        "icon": "M8 17L24 17A1 1 0 0 1 24 15L8 15A1 1 0 0 1 8 17ZM15 8L15 24A1 1 0 0 1 17 24L17 8A1 1 0 0 1 15 8ZM9.293 10.707L21.293 22.707A1 1 0 0 1 22.707 21.293L10.707 9.293A1 1 0 0 1 9.293 10.707ZM21.293 9.293L9.293 21.293A1 1 0 0 1 10.707 22.707L22.707 10.707A1 1 0 0 1 21.293 9.293ZM6 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM22 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM14 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM14 24a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
    })

with open(path, "w", encoding="utf-8") as fh:
    json.dump(entries, fh, indent=2)
    fh.write("\n")
PYEOF

    if ! python3 "$py_script" "$action" "$navi_path" "$kwc_url" 2>/dev/null; then
        warn "No write access to $navi_path, retrying with sudo..."
        if sudo python3 "$py_script" "$action" "$navi_path" "$kwc_url" 2>/dev/null; then
            sudo chown "$USER" "$navi_path" 2>/dev/null || true
        else
            warn "Could not update $navi_path (permission denied). Skipping."
        fi
    fi
    rm -f "$py_script"
    return 0
}

on_error() {
    local line_no="$1"
    local exit_code="$2"

    echo ""
    echo -e "${RED}Installer failed at line ${line_no} with exit code ${exit_code}.${NC}"
    echo -e "${YELLOW}Log file:${NC} ${LOG_FILE}"

    if [ -f "$SYSTEM_SERVICE_FILE" ]; then
        echo ""
        info "systemd status snapshot:"
        sudo systemctl status "$SERVICE_NAME" --no-pager || true
        echo ""
        info "Recent service logs:"
        sudo journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
    elif [ -f "$LEGACY_USER_SERVICE_FILE" ]; then
        echo ""
        info "legacy systemd user-service status snapshot:"
        systemctl --user status "$SERVICE_NAME" --no-pager || true
        echo ""
        info "Recent legacy user-service logs:"
        journalctl --user -u "$SERVICE_NAME" -n 50 --no-pager || true
    fi
}

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'on_error "$LINENO" "$?"' ERR

# Detect if we're already running from inside a valid clone of this repo.
# This avoids creating a duplicate when the local directory name differs in
# case from INSTALL_DIR (e.g. Klipper-Wire-Configurator vs klipper-wire-configurator).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATE_DIR="$(dirname "$SCRIPT_DIR")"
if [ -d "$CANDIDATE_DIR/.git" ] && [ -f "$CANDIDATE_DIR/scripts/install.sh" ] && [ "$CANDIDATE_DIR" != "$INSTALL_DIR" ]; then
    info "Running from an existing clone at $CANDIDATE_DIR. Using it as the install directory."
    INSTALL_DIR="$CANDIDATE_DIR"
fi

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
    echo ""
    echo -e "${YELLOW}Uninstalling Klipper Wire Configurator...${NC}"
    echo ""

    if sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Stopping system service..."
        sudo systemctl stop "$SERVICE_NAME"
    fi
    if sudo systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Disabling system service..."
        sudo systemctl disable "$SERVICE_NAME"
    fi
    if [ -f "$SYSTEM_SERVICE_FILE" ]; then
        info "Removing system service file..."
        sudo rm -f "$SYSTEM_SERVICE_FILE"
        sudo systemctl daemon-reload
    fi

    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Stopping legacy user service..."
        systemctl --user stop "$SERVICE_NAME"
    fi
    if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Disabling legacy user service..."
        systemctl --user disable "$SERVICE_NAME"
    fi
    if [ -f "$LEGACY_USER_SERVICE_FILE" ]; then
        info "Removing legacy user service file..."
        rm -f "$LEGACY_USER_SERVICE_FILE"
        systemctl --user daemon-reload
    fi

    if [ -d "$INSTALL_DIR" ]; then
        info "Removing installation directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    # Remove the KWC entry from Mainsail's navi.json (keeps any other custom
    # navigation entries the user added). Best-effort — no config dir, no problem.
    if mainsail_installed; then
        info "Removing KWC entry from Mainsail sidebar..."
        edit_mainsail_navi remove
    fi

    # Remove the Moonraker update_manager include (file + include line).
    remove_moonraker_updater

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
info "Installer log: $LOG_FILE"

# --- Check architecture ---
ARCH="$(uname -m)"
info "Detected architecture: $ARCH"
if [[ "$ARCH" != "armv7l" && "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
    warn "Unexpected architecture: $ARCH. Proceeding anyway..."
fi

DEB_ARCH="unknown"
if command -v dpkg >/dev/null 2>&1; then
    DEB_ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
fi
info "Detected package architecture: $DEB_ARCH"

# --- Check OS ---
if [ -f /etc/os-release ]; then
    . /etc/os-release
    info "Detected OS: $PRETTY_NAME"
else
    warn "Could not detect OS. Proceeding anyway..."
fi

# --- Install system dependencies ---
info "Updating package lists..."
sudo apt-get update

info "Installing system dependencies..."
sudo apt-get install -y -qq \
    python3 \
    python3-venv \
    python3-pip \
    git \
    curl \
    ca-certificates
ok "System dependencies installed."

# --- Install Node.js if not present or too old ---
get_node_major_version() {
    node --version | sed 's/v//' | cut -d. -f1
}

install_node_from_apt() {
    info "Installing Node.js from Raspberry Pi OS / Debian repositories..."
    sudo apt-get install -y nodejs npm
    ok "Node.js $(node --version) installed from apt."
}

install_node_from_nodesource() {
    info "Installing Node.js via NodeSource..."
    # Use NodeSource for a recent Node.js LTS on supported architectures.
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ok "Node.js $(node --version) installed."
}

install_node() {
    # NodeSource supports amd64 and arm64. For armhf/armv7 and other arches,
    # use distro packages to avoid setup-script architecture failures.
    if [[ "$ARCH" = "x86_64" && "$DEB_ARCH" = "amd64" ]] || [[ "$ARCH" = "aarch64" && "$DEB_ARCH" = "arm64" ]]; then
        install_node_from_nodesource
    else
        warn "NodeSource is not supported for detected architecture ($ARCH / $DEB_ARCH). Falling back to Raspberry Pi OS packages."
        install_node_from_apt
    fi

    NODE_VER="$(get_node_major_version)"
    if [ "$NODE_VER" -lt "$NODE_MIN_VERSION" ]; then
        error "Installed Node.js version $(node --version) is too old. Need >= $NODE_MIN_VERSION. On Raspberry Pi OS 32-bit, use Bookworm or newer."
    fi
}

if command -v node &>/dev/null; then
    NODE_VER="$(get_node_major_version)"
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

resolve_install_git_ref() {
    local current_branch="$1"

    if [ -n "$KWC_GIT_REF" ]; then
        echo "$KWC_GIT_REF"
        return
    fi

    if [ -n "$current_branch" ]; then
        echo "$current_branch"
        return
    fi

    echo "main"
}

checkout_remote_branch() {
    local branch="$1"
    local current_branch="$2"

    if [ "$current_branch" = "$branch" ]; then
        return
    fi

    if git show-ref --verify --quiet "refs/heads/$branch"; then
        git checkout "$branch" --quiet
    else
        git checkout -B "$branch" "origin/$branch" --quiet
    fi
}

# --- Clone or update repository ---
if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing installation found. Updating..."
    cd "$INSTALL_DIR"

    if [ -n "$(git status --porcelain)" ]; then
        error "Install directory has local changes. Commit, stash, or clean them before rerunning the installer."
    fi

    CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
    TARGET_GIT_REF="$(resolve_install_git_ref "$CURRENT_BRANCH")"

    git fetch --quiet origin

    if git show-ref --verify --quiet "refs/remotes/origin/$TARGET_GIT_REF"; then
        checkout_remote_branch "$TARGET_GIT_REF" "$CURRENT_BRANCH"
        git pull --ff-only --quiet origin "$TARGET_GIT_REF"
        ok "Repository updated on branch $TARGET_GIT_REF."
    else
        warn "Remote branch '$TARGET_GIT_REF' was not found. Falling back to origin/main."
        checkout_remote_branch "main" "$CURRENT_BRANCH"
        git pull --ff-only --quiet origin main
        ok "Repository updated on branch main."
    fi
else
    if [ -d "$INSTALL_DIR" ]; then
        warn "Directory $INSTALL_DIR exists but is not a git repo. Backing up..."
        mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
    fi
    info "Cloning repository..."
    if [ -n "$KWC_GIT_REF" ]; then
        git clone --depth 1 --branch "$KWC_GIT_REF" "$REPO_URL" "$INSTALL_DIR" --quiet
    else
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
    fi
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

# --- Ensure 32-bit ARM wheels are available (piwheels fallback) ---
# markupsafe (jinja2's dependency) ships no official armv7l wheels; Raspberry
# Pi OS configures piwheels by default, but minimal images may not. When pip
# has no index pointing at piwheels, add it as a fallback so the Pi 3B/4
# 32-bit install does not try to build markupsafe from source (needs a Rust
# toolchain not present on stock images).
if ! pip config list 2>/dev/null | grep -qi piwheels; then
    export PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:+$PIP_EXTRA_INDEX_URL }https://www.piwheels.org/simple"
    info "Added piwheels index for ARM wheel availability."
fi

info "Installing Python dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt
ok "Python dependencies installed."

deactivate

# --- Build frontend ---
info "Installing frontend dependencies..."
cd "$INSTALL_DIR/frontend"
if ! npm ci; then
    warn "npm ci failed, falling back to npm install"
    npm install
fi
ok "Frontend dependencies installed."

info "Building frontend (this may take a few minutes on Raspberry Pi)..."
if ! npm run build; then
    warn "Frontend build failed. Attempting recovery for npm optional dependency/native binding issues..."
    rm -rf node_modules package-lock.json
    npm install
    npm run build
fi
ok "Frontend built successfully."

cd "$INSTALL_DIR"

# --- Create data directory for projects ---
mkdir -p "$INSTALL_DIR/data/projects"

# --- Install systemd service ---
info "Setting up systemd service..."

if [ -f "$LEGACY_USER_SERVICE_FILE" ]; then
    info "Removing legacy systemd user service so Moonraker can manage the system service..."
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$LEGACY_USER_SERVICE_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
fi

sudo tee "$SYSTEM_SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Klipper Wire Configurator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}/backend
Environment=HOME=${HOME}
Environment=KWC_PORT=${KWC_PORT}
Environment=KWC_PROJECTS_DIR=${INSTALL_DIR}/data/projects
ExecStart=/usr/bin/env bash ${INSTALL_DIR}/scripts/run-service.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

if [ ! -f "$SYSTEM_SERVICE_FILE" ]; then
    error "Service file was not created at $SYSTEM_SERVICE_FILE"
fi

ok "Service installed and start requested."

# --- Wait for service to come up ---
info "Waiting for service to start..."
for i in $(seq 1 30); do
    if is_system_service_active && curl -sf "http://localhost:${KWC_PORT}/health" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

if is_legacy_user_service_active; then
    systemctl --user status "$SERVICE_NAME" --no-pager || true
    error "Legacy user service is still active. Stop it before using the Moonraker-managed system service."
fi

if ! is_system_service_active; then
    sudo systemctl status "$SERVICE_NAME" --no-pager || true
    sudo journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
    error "System service failed to reach the active state."
fi

if curl -sf "http://localhost:${KWC_PORT}/health" > /dev/null 2>&1; then
    ok "Service is running!"
else
    sudo systemctl status "$SERVICE_NAME" --no-pager || true
    sudo journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
    error "Service did not become healthy on http://localhost:${KWC_PORT}/health"
fi

# --- Get IP address ---
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="<your-pi-ip>"
fi

# --- Mainsail sidebar link (navi.json) ---
# Mainsail supports custom sidebar entries via navi.json in its .theme folder
# (inside the Klipper config dir). Fluidd and OctoPrint have no equivalent, so
# this only runs when Mainsail is detected. The link targets _blank so the
# Mainsail tab is preserved.
if mainsail_installed; then
    if resolve_mainsail_theme_dir > /dev/null; then
        info "Mainsail detected - adding KWC link to its sidebar (navi.json)..."
        edit_mainsail_navi add
        ok "Mainsail sidebar link configured."
    else
        warn "Mainsail detected but no Klipper config directory found; skipping sidebar link."
    fi
fi

# --- Moonraker update_manager entry ---
# Register KWC with Moonraker's update manager so updates are visible in
# Mainsail/Fluidd. Skips when there is no moonraker.conf (standalone SBC).
if resolve_moonraker_config_dir > /dev/null && [ -f "$(resolve_moonraker_config_dir)/moonraker.conf" ]; then
    info "Adding KWC to Moonraker update_manager..."
    install_moonraker_updater
    ok "Moonraker update_manager configured."
fi

# --- Done! ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Installation Complete!                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Installer completed successfully and the service passed the health check.${NC}"
echo -e "  Log file: ${YELLOW}${LOG_FILE}${NC}"
echo ""
echo -e "  Open in your browser:"
echo -e "    ${BLUE}http://${IP_ADDR}:${KWC_PORT}${NC}"
echo ""
echo -e "  Manage the service:"
echo -e "    Status:  ${YELLOW}sudo systemctl status ${SERVICE_NAME}${NC}"
echo -e "    Stop:    ${YELLOW}sudo systemctl stop ${SERVICE_NAME}${NC}"
echo -e "    Start:   ${YELLOW}sudo systemctl start ${SERVICE_NAME}${NC}"
echo -e "    Logs:    ${YELLOW}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
echo ""
echo -e "  Update:    ${YELLOW}cd ${INSTALL_DIR} && bash scripts/install.sh${NC}"
echo -e "  Uninstall: ${YELLOW}bash ${INSTALL_DIR}/scripts/install.sh --uninstall${NC}"
echo ""
echo -e "  Project files are stored in: ${INSTALL_DIR}/data/projects"
echo ""
