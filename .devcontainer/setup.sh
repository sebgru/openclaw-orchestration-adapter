#!/usr/bin/env bash
# .devcontainer/setup.sh — runs once inside the container after creation.
# Safe to re-run; all steps are idempotent.
set -euo pipefail

# ── System packages ───────────────────────────────────────────────────────────
echo "→ Installing system packages (vim, jq)…"
sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends vim jq

# ── Node dev tools ────────────────────────────────────────────────────────────
# Install the same tools used by CI so local and CI environments match.
if [ -f /workspace/package.json ]; then
    echo "→ Installing project dependencies…"
    cd /workspace
    npm install
else
    echo "→ No package.json yet — skipping project dependencies."
fi

echo "→ Installing standalone dev tools…"
npm install --global eslint@9 prettier@3

# ── Git config ────────────────────────────────────────────────────────────────
# .gitconfig is staged at /tmp/host-gitconfig (bind-mounted read-only).
# Copy it so git can write to ~/.gitconfig freely (bind-mounted files can't
# be atomically replaced, which causes "Device or resource busy" errors).
echo "→ Configuring git…"
if [ -s /tmp/host-gitconfig ]; then
    cp /tmp/host-gitconfig ~/.gitconfig
    echo "  ~/.gitconfig installed."
else
    echo "  No host .gitconfig found — skipping."
fi

# ── SSH keys ──────────────────────────────────────────────────────────────────
# .ssh is staged at /tmp/host-ssh (bind-mounted read-only from the host).
# We copy it to ~/.ssh with the permissions SSH requires (700/600).
# Contributors without an .ssh directory simply skip this step.
echo "→ Configuring SSH…"
if [ -d /tmp/host-ssh ] && [ -n "$(ls -A /tmp/host-ssh 2>/dev/null)" ]; then
    mkdir -p ~/.ssh
    cp -rp /tmp/host-ssh/. ~/.ssh/
    chmod 700 ~/.ssh
    find ~/.ssh -type f -exec chmod 600 {} \;
    echo "  SSH keys installed."
else
    echo "  No SSH keys found on host — skipping."
fi

# ── GitHub CLI ────────────────────────────────────────────────────────────────
# `gh` is installed via the github-cli devcontainer feature. Its auth token
# lives in ~/.config/gh/hosts.yml, staged read-only at /tmp/host-gh-config.
# Copy it so the host's `gh auth login` is reused inside the container.
echo "→ Configuring GitHub CLI…"
if [ -d /tmp/host-gh-config ] && [ -n "$(ls -A /tmp/host-gh-config 2>/dev/null)" ]; then
    mkdir -p ~/.config/gh
    cp -rp /tmp/host-gh-config/. ~/.config/gh/
    chmod 700 ~/.config/gh
    find ~/.config/gh -type f -exec chmod 600 {} \;
    echo "  Host gh config installed."
else
    echo "  No host gh config found — run 'gh auth login' to authenticate."
fi

echo ""
echo "✅ Container setup complete."
echo "   Workspace : /workspace"
echo "   Node      : $(node --version)"
echo "   npm       : $(npm --version)"
echo "   eslint    : $(eslint --version 2>&1 | head -1)"
echo "   prettier  : $(prettier --version 2>&1 | head -1)"
echo "   gh        : $(gh --version 2>&1 | head -1)"
echo "   gh auth   : $(gh auth status 2>&1 | head -1 || true)"
