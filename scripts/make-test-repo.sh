#!/usr/bin/env bash
# Çakışmalı örnek bir repo oluşturur: ./scripts/make-test-repo.sh <hedef-dizin>
# Yanına "uzak sunucu" olarak <hedef-dizin>-origin.git bare reposunu da kurar (origin/main).
#
#  main:     PROJ-101 (3. satır), PROJ-120 (6. satır),
#            task'sız commit (9. satır) -> 'feature/PROJ-150-footer' branch'i ile merge edildi
#  feature/PROJ-202-profile (checkout edilmiş halde):
#            3. satırı commit'li değiştirir, 9. satırı kaydedilmemiş (commit'siz) değiştirir,
#            util.js'de formatDate'i değiştirir (main henüz dokunmadı -> çakışma yok;
#            ./scripts/simulate-merge.sh ile main'e çakışan bir merge gelir)
set -euo pipefail

DIR="${1:?Kullanım: $0 <hedef-dizin>}"
ORIGIN="${DIR%/}-origin.git"
rm -rf "$DIR" "$ORIGIN"
mkdir -p "$DIR"
cd "$DIR"

export GIT_AUTHOR_NAME="Ayşe Yılmaz" GIT_AUTHOR_EMAIL="ayse@example.com"
export GIT_COMMITTER_NAME="Ayşe Yılmaz" GIT_COMMITTER_EMAIL="ayse@example.com"

git init -q -b main
git config user.name "Ayşe Yılmaz"
git config user.email "ayse@example.com"
git config commit.gpgsign false

cat > app.js <<'JS'
function login(user, password) {
  // TODO: doğrulama
  return true;
}

const VERSION = '1.0.0';

function footer() {
  return 'Copyright 2025';
}

module.exports = { login, footer, VERSION };
JS
cat > util.js <<'JS'
function formatDate(d) {
  return d.toISOString();
}

function slugify(s) {
  return s.toLowerCase().replace(/\s+/g, '-');
}

module.exports = { formatDate, slugify };
JS
git add app.js util.js
git commit -q -m "İlk sürüm"

git branch feature/PROJ-202-profile

# main: PROJ-101 login doğrulaması
sed -i.bak 's/  return true;/  return user \&\& password.length >= 8;/' app.js && rm app.js.bak
git commit -qam "PROJ-101: login doğrulaması eklendi"

# main: PROJ-120 sürüm (feature branch bu satıra dokunmuyor -> çakışma olmamalı)
sed -i.bak "s/1.0.0/1.1.0/" app.js && rm app.js.bak
git commit -qam "PROJ-120: sürüm 1.1.0"

# main'e merge ile gelen, mesajında task olmayan commit (task branch adından bulunmalı)
git checkout -q -b feature/PROJ-150-footer
export GIT_AUTHOR_NAME="Mehmet Kaya" GIT_AUTHOR_EMAIL="mehmet@example.com"
sed -i.bak "s/Copyright 2025/Copyright 2026 Firma A.Ş./" app.js && rm app.js.bak
git commit -qam "footer metni güncellendi"
git checkout -q main
git merge -q --no-ff --no-edit feature/PROJ-150-footer
git branch -q -D feature/PROJ-150-footer

# Uzak sunucu (origin) ve origin/main
git init -q --bare -b main "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q origin main
git fetch -q origin

# Sizin branch'iniz
export GIT_AUTHOR_NAME="Öznur" GIT_AUTHOR_EMAIL="oznur@example.com"
git checkout -q feature/PROJ-202-profile
sed -i.bak 's/  return true;/  return checkProfile(user);/' app.js && rm app.js.bak
sed -i.bak "s/return d.toISOString();/return d.toLocaleDateString('tr-TR');/" util.js && rm util.js.bak
git commit -qam "PROJ-202: profil kontrolü ve tarih formatı"

# Commit'lenmemiş değişiklik
sed -i.bak "s/Copyright 2025/© 2025/" app.js && rm app.js.bak

echo "Örnek repo hazır: $DIR (branch: feature/PROJ-202-profile, uzak: $ORIGIN)"
