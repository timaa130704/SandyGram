#!/usr/bin/env bash
# Сборка Linux-клиента (Electron) в один AppImage.
set -euo pipefail
cd "$(dirname "$0")/../linux"

echo "::group::npm ci"
npm ci
echo "::endgroup::"

echo "::group::electron-builder"
# На CI сеть есть, поэтому electron-builder собирает AppImage целиком сам.
npx electron-builder --linux AppImage
echo "::endgroup::"

OUT="../dist"
mkdir -p "$OUT"
# artifactName в package.json = SandyGram.AppImage
cp release/SandyGram.AppImage "$OUT/SandyGram.AppImage"
chmod +x "$OUT/SandyGram.AppImage"
ls -la "$OUT/SandyGram.AppImage"
