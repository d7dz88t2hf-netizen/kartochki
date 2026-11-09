#!/bin/bash
# Собирает «Карточки.app» для macOS из исходников в этой папке.
set -e
cd "$(dirname "$0")"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  echo "НУЖНЫ_ИНСТРУМЕНТЫ: установите «Инструменты командной строки» и запустите сборку снова"
  exit 2
fi
OUT="../Карточки.app"
rm -rf build && mkdir build
xcrun swiftc -O -target arm64-apple-macos11 main.swift -o build/arm64
if xcrun swiftc -O -target x86_64-apple-macos11 main.swift -o build/x86_64 2>/dev/null; then
  BIN="lipo"; else BIN="arm64"; fi
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
if [ "$BIN" = lipo ]; then lipo -create build/arm64 build/x86_64 -output "$OUT/Contents/MacOS/Kartochki"
else cp build/arm64 "$OUT/Contents/MacOS/Kartochki"; fi
cp Info.plist "$OUT/Contents/Info.plist"
printf 'APPL????' > "$OUT/Contents/PkgInfo"
cp AppIcon.icns "$OUT/Contents/Resources/AppIcon.icns"
cp -R web "$OUT/Contents/Resources/web"
codesign --force --deep -s - "$OUT"
rm -rf build
echo "ГОТОВО: $(lipo -archs "$OUT/Contents/MacOS/Kartochki")"
