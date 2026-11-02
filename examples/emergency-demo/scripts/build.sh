#!/usr/bin/env bash
# Compiles the demo "application": concatenates the sources into build/app.txt with the version.
set -euo pipefail
version="${1:?version required}"
mkdir -p build
{
  echo "emergency-demo ${version}"
  cat src/app/main.txt
} > build/app.txt
echo "Compiled build/app.txt ($(wc -l < build/app.txt) lines)"
