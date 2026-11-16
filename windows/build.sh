#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags '-s -w -H=windowsgui' -o 'dist/Карточки.exe' ./windows
printf 'Готово: dist/Карточки.exe\n'
