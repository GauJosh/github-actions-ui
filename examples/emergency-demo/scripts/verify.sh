#!/usr/bin/env bash
# Checks that the checksum and stamp produced by earlier jobs look right.
set -euo pipefail
checksum="${1:?checksum required}"
stamp="${2:?stamp required}"
[[ "${checksum}" =~ ^[0-9a-f]{16}$ ]] || { echo "::error::bad checksum ${checksum}"; exit 1; }
[[ "${stamp}" =~ ^[0-9.]+\+[0-9a-f]{12}$ ]] || { echo "::error::bad stamp ${stamp}"; exit 1; }
echo "Verified checksum ${checksum} and stamp ${stamp}"
