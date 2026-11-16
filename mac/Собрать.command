#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
OUT="../dist/Карточки.app"
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/kartochki-build.XXXXXX")
trap 'rm -rf "$BUILD"' EXIT
mkdir -p ../dist .build/module-cache
for ARCH in arm64 x86_64; do
  xcrun swiftc -O -target "$ARCH-apple-macos11" -module-cache-path "$PWD/.build/module-cache" main.swift Storage.swift -o "$BUILD/$ARCH"
done
APP="$BUILD/Карточки.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$BUILD/arm64" "$BUILD/x86_64" -output "$APP/Contents/MacOS/Kartochki"
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R ../web "$APP/Contents/Resources/web"
codesign --force --options runtime --sign "${SIGN_IDENTITY:--}" "$APP"
codesign --verify --strict "$APP"
rm -rf "$OUT"
mv "$APP" "$OUT"
echo "Готово: $OUT ($(lipo -archs "$OUT/Contents/MacOS/Kartochki"))"
