#!/usr/bin/env bash
# Klipper Wire Configurator - One-Line Installer for Raspberry Pi (Raspbian Lite)
#
# Install with:
#   curl -sSL https://raw.githubusercontent.com/YOUR_USER/Klipper-Wire-Configurator/main/scripts/install.sh | bash
#
# Or if you've already cloned the repo:
#   bash scripts/install.sh
#
# IMPORTANT: run WITHOUT sudo. The installer escalates internally wherever
# elevated access is needed (apt, systemd, and writes into the Moonraker
# config dir). Running `sudo bash scripts/install.sh` resets $HOME to /root,
# so the Moonraker config directory is not found and the update_manager /
# Mainsail sidebar setup is silently skipped (and the app installs into
# /root instead of your user's home). If sudo is used anyway, the guard
# below re-execs the script as the invoking user automatically.
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
# LOG_FILE is honoured from the environment so the sudo-guard re-exec can
# hand the same log path to the child (one continuous install log).
LOG_FILE="${LOG_FILE:-${LOG_DIR}/klipper-wire-configurator-install-$(date +%Y%m%d-%H%M%S).log}"
SYSTEM_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LEGACY_USER_SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
# Path to meminfo for the low-memory Node heap guard. Overridable so the guard
# can be exercised without a small host (mirrored in scripts/run-service.sh).
MEMINFO_FILE="${KWC_MEMINFO_FILE:-/proc/meminfo}"

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

# --- Sudo guard ---
# The installer must run as the invoking (non-root) user: INSTALL_DIR, the
# Moonraker config-dir lookup, and Mainsail detection all hang off $HOME,
# which `sudo` rewrites to /root. If someone runs the script under sudo
# anyway, re-exec it as the original user (SUDO_USER) with that user's
# HOME restored and the supported KWC_* vars passed through explicitly.
# Running as root without sudo (direct root login, or curl | sudo bash)
# is unrecoverable, so fail loudly.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    real_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    warn "Running under sudo; re-executing as '$SUDO_USER' (the installer must run as your user)."
    # The main log tee isn't installed yet (it lives below the function
    # definitions), so seed the log file with this notice ourselves; the
    # re-exec'd child inherits LOG_FILE and continues the same log.
    # The seed file is created root-owned here (the exec below skips the
    # tee-site chmod), so loosen it or the user child can't append.
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    echo "[sudo-guard] re-executing installer as '$SUDO_USER'" >> "$LOG_FILE" 2>/dev/null || true
    chmod 666 "$LOG_FILE" 2>/dev/null || true
    # Unset SUDO_USER for the re-exec so the guard can't loop even if the
    # child still somehow sees EUID 0. Supported KWC_* env vars are passed
    # explicitly because sudo's -E preservation needs sudoers `setenv` and
    # fails open otherwise.
    kwc_env=("KWC_PORT=${KWC_PORT:-8099}" "KWC_GIT_REF=${KWC_GIT_REF:-}" "LOG_FILE=$LOG_FILE")
    [ -n "${KWC_PROJECTS_DIR:-}" ] && kwc_env+=("KWC_PROJECTS_DIR=$KWC_PROJECTS_DIR")
    exec env -u SUDO_USER sudo -u "$SUDO_USER" \
        env "HOME=$real_home" "USER=$SUDO_USER" "${kwc_env[@]}" \
        bash "${BASH_SOURCE[0]}" "$@"
fi
if [ "$(id -u)" -eq 0 ]; then
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    echo "[sudo-guard] refused: installer run as root without SUDO_USER" >> "$LOG_FILE" 2>/dev/null || true
    error "Do not run this installer as root. Run it as your normal user WITHOUT sudo (it escalates internally where needed): bash scripts/install.sh"
fi

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

# NOTE: there is deliberately no moonraker.asvc handling here. Moonraker's
# is_service_allowed() (machine.py) unconditionally permits any service whose
# name matches ^klipper[_-]?\d* or ^moonraker[_-]?\d*, independently of the
# allow-list file, and this service is named klipper-wire-configurator. The
# exemption shipped in the same commit that introduced the allow-list
# (Moonraker 690f841, 2022-12-29), so an entry has never been required.
# Verified live 2026-10-01: with no entry in moonraker.asvc, Moonraker's
# /machine/services/restart?service=klipper-wire-configurator returned ok and
# the unit's MainPID changed.

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

# Best-effort: restart Moonraker so update_manager picks up config changes.
# Only restarts when the unit exists and is active; never aborts the install.
restart_moonraker() {
    if systemctl list-unit-files moonraker.service > /dev/null 2>&1 && \
       systemctl is-active --quiet moonraker; then
        if sudo systemctl restart moonraker 2>/dev/null; then
            info "Moonraker restarted to pick up update_manager changes."
        else
            warn "Could not restart moonraker automatically — restart it manually (systemctl restart moonraker) for update_manager changes to take effect."
        fi
    fi
}

# Moonraker reads moonraker.conf once at startup, so every writer below only
# marks the change and the caller applies a single restart at the end.
MOONRAKER_RESTART_NEEDED=0

mark_moonraker_restart_needed() {
    MOONRAKER_RESTART_NEEDED=1
}

apply_moonraker_changes() {
    if [ "$MOONRAKER_RESTART_NEEDED" -eq 1 ]; then
        restart_moonraker
        MOONRAKER_RESTART_NEEDED=0
    fi
}

# Add KWC to Moonraker's update manager so updates show up in Mainsail /
# Fluidd. Writes a dedicated include file (same pattern as obico's
# moonraker-obico-update.cfg) and adds a single [include] line to
# moonraker.conf — the user's other sections are left untouched. Best-effort:
# failures warn and return 0 so the install never aborts over this.
install_moonraker_updater() {
    local config_dir moonraker_conf include_file content changed=0
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
    # Idempotent: only rewrite + restart when the include file differs.
    if [ ! -f "$include_file" ] || ! cmp -s "$include_file" <(printf '%s' "$content") 2>/dev/null; then
        write_file_elevated "$include_file" "$content" || return 0
        changed=1
    fi

    if ! grep -q '^\[include klipper-wire-configurator-update\.cfg\]' "$moonraker_conf"; then
        # Terminate the user's last line first. Appending to a config with no
        # trailing newline merges the directive into it — corrupting a file we
        # do not own, and producing text the removal above can never match, so
        # --uninstall could not undo it.
        ensure_trailing_newline "$moonraker_conf"
        if append_line_elevated "$moonraker_conf" "[include klipper-wire-configurator-update.cfg]"; then
            changed=1
        else
            warn "Could not add the include line to $moonraker_conf — add it manually:"
            warn "  [include klipper-wire-configurator-update.cfg]"
        fi
    fi
    if [ "$changed" -eq 1 ]; then
        mark_moonraker_restart_needed
    fi
    return 0
}

# Remove the KWC update_manager include (file + include line) from the
# Moonraker config directory. Best-effort.
remove_moonraker_updater() {
    local config_dir moonraker_conf include_file changed=0
    config_dir="$(resolve_moonraker_config_dir)" || return 0
    moonraker_conf="$config_dir/moonraker.conf"
    include_file="$config_dir/klipper-wire-configurator-update.cfg"

    if [ -e "$include_file" ]; then
        # Only claim a change when the file is actually gone: setting changed=1
        # unconditionally restarted Moonraker for a removal that never
        # happened (a failed rm with no usable sudo).
        if ! rm -f "$include_file" 2>/dev/null; then
            sudo rm -f "$include_file" 2>/dev/null || true
        fi
        if [ ! -e "$include_file" ]; then
            changed=1
        else
            warn "Could not remove $include_file — remove it manually."
        fi
    fi
    if [ -f "$moonraker_conf" ]; then
        local had_line=0
        if grep -q '^\[include klipper-wire-configurator-update\.cfg\]' "$moonraker_conf"; then
            had_line=1
        fi
        if ! sed -i '/^\[include klipper-wire-configurator-update\.cfg\]$/d' "$moonraker_conf" 2>/dev/null; then
            sudo sed -i '/^\[include klipper-wire-configurator-update\.cfg\]$/d' "$moonraker_conf" 2>/dev/null || true
        fi
        if [ "$had_line" -eq 1 ]; then
            if grep -q '^\[include klipper-wire-configurator-update\.cfg\]' "$moonraker_conf"; then
                warn "Could not remove the include line from $moonraker_conf — remove it manually."
            else
                changed=1
            fi
        fi
    fi
    if [ "$changed" -eq 1 ]; then
        mark_moonraker_restart_needed
    fi
    return 0
}

# Terminate a file's last line so an appended entry starts on its own line.
# Without this, a hand-edited file with no trailing newline merges the new
# entry into the previous line — corrupting a config the installer does not
# own, and making the added text unfindable, so --uninstall can never remove it.
#
# Escalates like the append helpers: a file that needs `sudo tee -a` to append
# also needs elevation to add the newline, and silently doing nothing here would
# reintroduce exactly the merge this exists to prevent.
ensure_trailing_newline() {
    local file="$1"
    [ -s "$file" ] || return 0
    # Command substitution strips trailing newlines, so an empty result means
    # the file already ends with one.
    [ -n "$(tail -c 1 "$file" 2>/dev/null)" ] || return 0
    if printf '\n' >> "$file" 2>/dev/null; then
        return 0
    fi
    warn "No write access to $file, retrying with sudo..."
    printf '\n' | sudo tee -a "$file" > /dev/null 2>&1 || true
}

# Merge (or remove) the KWC entry in Mainsail's navi.json. Keeps any other
# custom navigation entries the user already has. Best-effort: failures warn
# and return 0 so the install never aborts over this.
edit_mainsail_navi() {
    local action="$1"  # add | remove
    local theme_dir navi_path kwc_url py_script
    theme_dir="$(resolve_mainsail_theme_dir)" || return 0
    navi_path="$theme_dir/navi.json"
    kwc_url="http://${IP_ADDR:-localhost}:${KWC_PORT}"

    # Nothing to clean if the navi file was never written.
    if [ "$action" = "remove" ] && [ ! -f "$navi_path" ]; then
        return 0
    fi
    # Only create the theme dir when adding — remove must not leave one behind.
    if [ "$action" = "add" ] && ! mkdir -p "$theme_dir" 2>/dev/null; then
        sudo mkdir -p "$theme_dir" 2>/dev/null || return 0
    fi

    py_script="$(mktemp)"
    cat > "$py_script" <<'PYEOF'
import json
import os
import shutil
import sys

action, path, url = sys.argv[1], sys.argv[2], sys.argv[3]

# Load existing entries. A pre-existing navi.json must never be destroyed:
# when the current content is not a parseable list (corrupt JSON or a
# non-array shape), back it up before we replace it (add) or leave it alone
# (remove).
existing_raw = None
entries = []
parseable = True
try:
    with open(path, encoding="utf-8") as fh:
        existing_raw = fh.read()
    parsed = json.loads(existing_raw)
    if not isinstance(parsed, list):
        parseable = False
    else:
        entries = parsed
except (OSError, ValueError):
    parseable = False

if not parseable:
    # Don't touch a corrupt/unexpected file on remove.
    if action == "remove":
        sys.exit(0)
    # Preserve the original before replacing it on add.
    if existing_raw is not None:
        try:
            shutil.copy2(path, path + ".bak")
        except OSError:
            pass

entries = [
    e for e in entries
    if not (isinstance(e, dict) and e.get("title") == "KWC")
]

if action == "remove":
    # Delete the file when the KWC entry was the only custom entry; keep it
    # (minus KWC) when the user has other custom navigation entries.
    if entries:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(entries, fh, indent=2)
            fh.write("\n")
    else:
        try:
            os.remove(path)
        except OSError:
            # Signal failure so the caller retries under sudo.
            sys.exit(1)
    sys.exit(0)

if action == "add":
    # KWC favicon mark (frontend/public/favicon.svg) converted to a single
    # filled SVG path: the 4-spoke asterisk + tip dots, background square
    # dropped (nav icons render monochrome with the sidebar text color).
    # Coordinates shifted (-2,-4) from the favicon so the whole mark sits
    # inside the 24x24 viewBox with margin — the original touched the right
    # edge and overflowed the bottom, clipping the tip dots.
    entries.append({
        "title": "KWC",
        "href": url,
        "target": "_blank",
        "position": 95,
        "icon": "M6 13L22 13A1 1 0 0 1 22 11L6 11A1 1 0 0 1 6 13ZM13 4L13 20A1 1 0 0 1 15 20L15 4A1 1 0 0 1 13 4ZM7.293 6.707L19.293 18.707A1 1 0 0 1 20.707 17.293L8.707 5.293A1 1 0 0 1 7.293 6.707ZM19.293 5.293L7.293 17.293A1 1 0 0 1 8.707 18.707L20.707 6.707A1 1 0 0 1 19.293 5.293ZM4 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM20 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM12 4a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM12 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
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
# Pre-create the log BEFORE the tee opens it. Under `sudo bash install.sh`
# this runs as root just before the guard re-execs the install as the
# invoking user; a file created lazily by tee would be root-owned 644 and
# the user child could not append. Creating it here and loosening it keeps
# one continuous install log across the re-exec. (Same tradeoff /tmp temp
# files already make: any local user may append to a timestamped log.)
touch "$LOG_FILE"
chmod 666 "$LOG_FILE" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'on_error "$LINENO" "$?"' ERR

# --- Sudo credential lifetime ---
# sudo caches credentials for timestamp_timeout (15 minutes by default, per
# tty). This installer's two sudo-requiring phases — apt at the start and the
# systemd service at the end — straddle the pip install, `npm ci` and the Vite
# build, which is 15-40 minutes on a Pi Zero 2 W. Without this the password is
# requested a second time mid-install with no explanation (field report
# 2026-10-01, V2.7.0), which under `curl | bash` reads as a hang. Ask once and
# keep the timestamp warm for the whole run.
SUDO_KEEPALIVE_PID=""

start_sudo_keepalive() {
    info "Administrator access is needed for the apt packages and the systemd service."
    if ! sudo -v; then
        error "This installer needs sudo (apt packages and the systemd service)."
    fi
    # -n inside the loop: never prompt from the background, and exit quietly if
    # the timestamp can no longer be refreshed (sudoers changed, timeout raised).
    # Also fine on NOPASSWD hosts, where `sudo -v` is a silent no-op.
    ( while true; do sudo -n true 2>/dev/null || exit; sleep 60; done ) &
    SUDO_KEEPALIVE_PID=$!
    trap stop_sudo_keepalive EXIT
}

stop_sudo_keepalive() {
    # Deliberately no `wait`: waiting on a subshell parked in `sleep` can hang
    # the exit path. Kill it and move on.
    if [ -n "${SUDO_KEEPALIVE_PID:-}" ]; then
        kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    fi
}

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
    apply_moonraker_changes

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
start_sudo_keepalive
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
# Low-memory guard: Node's default V8 old-space is sized from physical memory
# and on 32-bit ARM is far too small for this bundle (~123 MB observed) — the
# process ABORTS at that ceiling long before the system's swap is used (swap
# is invisible to a self-imposed heap limit). On devices with < 2 GB combined
# RAM+swap, size the heap to ~half of that total so npm/Vite page into swap
# instead of aborting. Verified on a Pi Zero 2 W (424 MB RAM + 1 GB swap):
# npm ci died at ~130 MB with "Reached heap limit" until this was set
# (2026-09-06). Mirrored in scripts/run-service.sh — keep the two in sync.
total_mem_mb=$(awk '/MemTotal/ {m=$2} /SwapTotal/ {s=$2} END {printf "%d", (m+s)/1024}' "$MEMINFO_FILE" 2>/dev/null || echo 0)
if [ "${total_mem_mb:-0}" -lt 2048 ]; then
    node_heap_mb=$(( total_mem_mb / 2 ))
    [ "$node_heap_mb" -lt 384 ] && node_heap_mb=384
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$node_heap_mb"
    info "Low-memory device (${total_mem_mb} MB RAM+swap): Node heap raised to ${node_heap_mb} MB."
fi

cd "$INSTALL_DIR/frontend"

# Swap a freshly built staging bundle into place, checking EVERY step.
#
# This runs inside `if ! ...`, where bash suspends errexit for the whole call
# (Shell Functions, POSIX: "if a compound command or shell function executes
# in a context where -e is being ignored, none of the commands executed
# within ... will be affected by the -e setting"). An unchecked `mv` therefore
# fails silently and control falls through to the success path — observed
# 2026-10-01: every rename was denied, the log still said "Frontend bundle
# updated." and the caller returned 0 with dist/ holding the old bundle and
# the new one stranded in dist.next.
#
# Two renames cannot be atomic, so dist/ is never left absent: if the second
# rename fails, the first is undone.
#
# Kept byte-identical in scripts/install.sh and scripts/run-service.sh —
# change both or neither.
swap_staged_bundle() {
    local dir="${1:?frontend directory required}"
    local dist="$dir/dist" staging="$dir/dist.next" previous="$dir/dist.previous"

    if [ -e "$previous" ] && ! rm -rf "$previous"; then
        warn "Could not clear $previous; keeping the current bundle."
        return 1
    fi
    if [ -e "$dist" ] && ! mv "$dist" "$previous"; then
        warn "Could not move the current bundle aside; keeping it in place."
        return 1
    fi
    if ! mv "$staging" "$dist"; then
        warn "Could not put the new bundle in place; restoring the previous one."
        if [ -e "$previous" ]; then
            mv "$previous" "$dist" 2>/dev/null || \
                warn "Could not restore $previous — it is still there for a manual move."
        fi
        return 1
    fi
    return 0
}

# A bundle sitting in dist.previous is still perfectly good: an interrupted
# swap, or a failed build after the old bundle was moved aside, leaves the UI
# dead while a usable bundle is on disk. Put it back rather than serve nothing.
#
# Kept byte-identical in scripts/install.sh and scripts/run-service.sh —
# change both or neither.
restore_previous_bundle_if_needed() {
    local dir="${1:?frontend directory required}"
    local dist="$dir/dist" previous="$dir/dist.previous"

    if [ ! -f "$dist/index.html" ] && [ -f "$previous/index.html" ]; then
        warn "No bundle in $dist; restoring the previous one from $previous."
        rm -rf "$dist"
        if mv "$previous" "$dist"; then
            return 0
        fi
        warn "Could not restore the previous bundle; the web UI will be unavailable."
    fi
    return 0
}

# Build into a staging directory and swap it into place. Vite empties its
# output directory first, so building straight into dist/ would destroy the
# bundle the running service is still serving whenever a build fails.
#
# Explicit paths rather than relying on the caller's cwd: this is called from
# the main install body and from the recovery path, and an unnoticed `cd`
# between the two would silently build the wrong directory.
build_frontend_staged() {
    local frontend_dir="$INSTALL_DIR/frontend"
    rm -rf "$frontend_dir/dist.next"
    if ! ( cd "$frontend_dir" && npm run build -- --outDir dist.next ); then
        rm -rf "$frontend_dir/dist.next"
        return 1
    fi
    if [ ! -f "$frontend_dir/dist.next/index.html" ]; then
        rm -rf "$frontend_dir/dist.next"
        return 1
    fi
    swap_staged_bundle "$frontend_dir" || return 1
    return 0
}

# Recovery path for npm optional-dependency / native-binding failures: rebuild
# node_modules from scratch, then build again.
#
# package-lock.json is TRACKED and this path deliberately deletes it, so it is
# restored from git on EVERY exit, not only on success. Returning early with
# the lock file missing dirties the checkout, which (a) aborts every later
# installer run at the clean-tree gate below and (b) breaks `npm ci` in
# run-service.sh's rebuild-on-start, permanently degrading that path to
# fail-open warnings.
recover_frontend_build() {
    local frontend_dir="$INSTALL_DIR/frontend" rc=0
    rm -rf "$frontend_dir/node_modules" "$frontend_dir/package-lock.json"
    if ! ( cd "$frontend_dir" && npm install ); then
        rc=1
    elif ! build_frontend_staged; then
        rc=1
    fi
    ( cd "$frontend_dir" && git checkout -- package-lock.json ) 2>/dev/null || true
    return "$rc"
}

# Take the same lock as the service's own rebuild-on-start: two concurrent
# Vite builds OOM each other on a small host (observed 2026-10-01).
with_frontend_build_lock() {
    if ! command -v flock >/dev/null 2>&1; then
        "$@"
        return $?
    fi
    local lock_fd rc=0
    # No 2>/dev/null here: `exec` with only redirections applies them to the
    # SHELL, so silencing it would swallow every later installer diagnostic.
    if ! exec {lock_fd}>>"$INSTALL_DIR/frontend/.kwc-build.lock"; then
        "$@"
        return $?
    fi
    flock "$lock_fd"
    "$@" || rc=$?
    flock -u "$lock_fd" 2>/dev/null || true
    exec {lock_fd}>&-
    return "$rc"
}

info "Installing frontend dependencies..."
if ! with_frontend_build_lock npm ci; then
    warn "npm ci failed, falling back to npm install"
    with_frontend_build_lock npm install
fi
ok "Frontend dependencies installed."

info "Building frontend (this may take a few minutes on Raspberry Pi)..."
if ! with_frontend_build_lock build_frontend_staged; then
    warn "Frontend build failed. Attempting recovery for npm optional dependency/native binding issues..."
    if ! with_frontend_build_lock recover_frontend_build; then
        # A usable bundle may still be on disk — an interrupted swap leaves one
        # in dist.previous. Put it back before aborting, so the service has
        # something to serve rather than starting with no UI at all.
        restore_previous_bundle_if_needed "$INSTALL_DIR/frontend"
        error "Frontend build failed. Any previously built bundle was left untouched; the service keeps serving it."
    fi
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
# Never let this abort the install. `hostname` is not guaranteed to exist, and
# under `set -o pipefail` a failing command inside the substitution fails the
# assignment, trips the ERR trap, and exits — after the service is installed but
# BEFORE the Moonraker registration below, making the explicit empty-value
# fallback dead code in exactly the case it was written for.
#
# Prefer the address of the interface that actually routes: `hostname -I`
# returns the first address on any interface, which can be a WireGuard or
# secondary NIC that nothing else can reach.
IP_ADDR="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
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
        if [ -z "$IP_ADDR" ] || [ "$IP_ADDR" = "<your-pi-ip>" ]; then
            # Never write a link with a placeholder URL — a navi.json entry
            # pointing at "<your-pi-ip>" would silently 404 with no signal.
            warn "Could not detect the Pi's IP address; skipping the Mainsail sidebar link."
            warn "Add it later manually: a KWC entry in the .theme folder of your Klipper config dir (see README 'Mainsail sidebar link')."
        else
            info "Mainsail detected - adding KWC link to its sidebar (navi.json)..."
            edit_mainsail_navi add
            ok "Mainsail sidebar link configured."
        fi
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
    apply_moonraker_changes
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
