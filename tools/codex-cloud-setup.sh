#!/usr/bin/env bash
# Setup script for a Codex Cloud environment: bash tools/codex-cloud-setup.sh
# The default image has Node and Python (with uv) but no ffmpeg or Chromium.
# Same steps as CI (.github/workflows/ci.yml). See docs/codex.md (Codex Cloud).
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg
npm ci
npx playwright-core install --with-deps chromium
npx mvs doctor
