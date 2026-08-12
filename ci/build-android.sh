#!/usr/bin/env bash
# Сборка release-APK. Работает и на GitHub Actions, и локально.
#
# Важно про подпись: релизы 2.x подписаны debug-ключом, который Expo генерирует
# при prebuild. Если собрать со свежесгенерированным ключом, APK не встанет
# поверх установленного (signature mismatch). Поэтому ключ приезжает из
# ANDROID_KEYSTORE_B64 (base64 файла app/android/app/debug.keystore).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "::group::versions"
node --version
java -version 2>&1 | head -1
echo "::endgroup::"

cd app

echo "::group::npm ci"
npm ci
echo "::endgroup::"

echo "::group::expo prebuild"
# --no-install: зависимости уже стоят; --clean, чтобы android/ был предсказуемым
npx expo prebuild --platform android --no-install --clean
echo "::endgroup::"

if [ -n "${ANDROID_KEYSTORE_B64:-}" ]; then
  echo "Ставим keystore из ANDROID_KEYSTORE_B64"
  printf '%s' "$ANDROID_KEYSTORE_B64" | base64 -d > android/app/debug.keystore
else
  echo "ВНИМАНИЕ: ANDROID_KEYSTORE_B64 не задан — APK подпишется свежим ключом" >&2
  echo "и НЕ установится поверх предыдущей версии." >&2
fi

echo "::group::gradle assembleRelease"
cd android
chmod +x gradlew
./gradlew --no-daemon assembleRelease
cd ..
echo "::endgroup::"

OUT="../dist"
mkdir -p "$OUT"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT/SandyGram.apk"

# Проверяем, что версия внутри APK совпадает с app.json — ловим забытый bump
if command -v aapt2 >/dev/null 2>&1; then
  aapt2 dump badging "$OUT/SandyGram.apk" | grep -E "^package:" || true
fi
node -e "const v=require('./app.json').expo;console.log('app.json:',v.version,'versionCode',v.android?.versionCode??v.versionCode)"
ls -la "$OUT/SandyGram.apk"
