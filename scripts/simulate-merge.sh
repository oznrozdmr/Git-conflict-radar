#!/usr/bin/env bash
# Başka bir geliştiricinin main'e merge yapıp push etmesini taklit eder:
#   ./scripts/simulate-merge.sh <make-test-repo.sh ile oluşturulan dizin>
# util.js'deki formatDate satırını değiştiren feature/PROJ-303-date-format branch'i main'e merge edilir.
# Commit mesajında task yok; task branch adından (PROJ-303) bulunmalı.
set -euo pipefail

DIR="${1:?Kullanım: $0 <demo-dizini>}"
ORIGIN="${DIR%/}-origin.git"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export GIT_AUTHOR_NAME="Zeynep Demir" GIT_AUTHOR_EMAIL="zeynep@example.com"
export GIT_COMMITTER_NAME="Zeynep Demir" GIT_COMMITTER_EMAIL="zeynep@example.com"

git clone -q "$ORIGIN" "$WORK/w"
cd "$WORK/w"
git config commit.gpgsign false
git checkout -q -b feature/PROJ-303-date-format
sed -i.bak "s/return d.toISOString();/return d.toISOString().slice(0, 10);/" util.js && rm util.js.bak
git commit -qam "tarih formatı kısaltıldı"
git checkout -q main
git merge -q --no-ff --no-edit feature/PROJ-303-date-format
git push -q origin main

echo "main'e merge edildi: feature/PROJ-303-date-format ($(git rev-parse --short HEAD))"
