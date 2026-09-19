# Git Conflict Radar

Siz kendi branch'inizde çalışırken **main dalında da değiştirilmiş satırları** merge'den önce gösterir.

- 🟧 **Renkli işaretleme:** Çakışma riski olan satırlar turuncu arka planla, gutter ikonuyla ve kaydırma çubuğunda işaretlenir.
- 🏷️ **Task bilgisi:** Satırın sonunda ve hover'da o bölgeyi main'de hangi task'ın, hangi commit'in ve kimin değiştirdiği gösterilir. main'deki değişikliğin diff'i de hover'da yer alır.
- ⚠️ **Tekrar düzenleyin uyarısı:** Her çakışma Problems paneline uyarı olarak düşer. Yeni çakışma bulunduğunda bir bildirim gösterilir.
- ✍️ **Kaydedilmemiş değişiklikler dahil:** Karşılaştırma editördeki güncel içerikle yapılır. Yazarken işaretler güncellenir.
- 📡 **Arka planda main takibi:** Biri main'e merge yaptığında eklenti bunu kendiliğinden fark eder (varsayılan: 60 sn içinde). Sadece main dalını fetch eder, branch'inizi tarar ve anında bildirim gösterir: *"origin/main'e yeni değişiklik geldi: PROJ-303 (Zeynep Demir). 1 dosyada çakışma riski: util.js. Lütfen tekrar düzenleyin."*
- 🗂️ **Tüm branch taranır:** Açmadığınız dosyalar da taranır. Hem sizin hem main'in değiştirdiği her dosyadaki çakışmalar Problems panelinde ve **Tüm çakışmaları listele** ekranında görünür.

## Nasıl çalışır?

1. Sizin `HEAD`'iniz ile ana dal (`origin/main`, yoksa `main`/`master`) arasındaki ortak ata (`git merge-base`) bulunur.
2. Ortak atadan beri **main'de** değişen satırlar (`git diff -U0 base main`) ve **sizin** değiştirdiğiniz satırlar (editör içeriği ↔ ortak ata) çıkarılır.
3. İki taraf aynı ya da bitişik satırlara dokunuyorsa (git'in çakışma kuralı) bölge işaretlenir. İki tarafta birebir aynı yapılmış değişiklikler atlanır.
4. Açılışta, dal değişiminde, kaydetmede ve main her güncellendiğinde, iki tarafta da değişen **tüm dosyalar** (`git diff --name-only`) bu yöntemle taranır.
5. Uzak main her `remoteCheckSeconds` saniyede bir `git ls-remote` ile kontrol edilir. Bu çok hafif bir istek; yalnızca son commit'in kimliği alınır. Değişmişse yalnızca o dal fetch edilir. Arka plandaki git komutları hiçbir zaman şifre sormaz. Uzak sunucu kimlik doğrulama isterse kontrol sessizce atlanır ve Output → Git Conflict Radar'a yazılır.
6. main tarafındaki satırlar `git blame` ile commit'lere bağlanır. Task ID'si şu sırayla aranır:
   1. Commit mesajı (ör. `PROJ-123: login düzeltildi`)
   2. Commit'i main'e getiren merge commit'teki branch adı (ör. `Merge branch 'feature/PROJ-123-login'`, `Merge pull request #5 from ayse/feature/PROJ-123`)
   3. Merge commit mesajının kendisi (ör. PR numarası `#5`)

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `gitConflictRadar.mainBranch` | `origin/main` | Karşılaştırılacak dal. Bulunamazsa `main`, `master` denenir. |
| `gitConflictRadar.taskPattern` | `[A-Z][A-Z0-9]+-\d+\|#\d+` | Task ID regex'i. |
| `gitConflictRadar.taskUrlTemplate` | – | Örn. `https://jira.firma.com/browse/{id}`. Doluysa task hover'da bağlantı olur. |
| `gitConflictRadar.remoteCheckSeconds` | `60` | Uzak main'in kaç saniyede bir kontrol edileceği. 0 = kapalı (en az 5). |
| `gitConflictRadar.showNotifications` | `true` | Yeni çakışmada bildirim göster. |
| `gitConflictRadar.enabled` | `true` | Eklentiyi aç/kapat. |

Renkleri `workbench.colorCustomizations` ile değiştirebilirsiniz:

```json
"workbench.colorCustomizations": {
  "gitConflictRadar.conflictBackground": "#ff000030",
  "gitConflictRadar.conflictRuler": "#ff0000"
}
```

## Komutlar

- **Git Conflict Radar: Yenile**
- **Git Conflict Radar: main dalını getir (git fetch)**: `origin/main` gibi uzak dallar için güncel hali çeker.
- **Git Conflict Radar: main ile karşılaştır**: Dosyanın main'deki hali ile yan yana diff açar.
- **Git Conflict Radar: Tüm çakışmaları listele**: Durum çubuğundaki `⚠` öğesine tıklamakla aynı işi yapar. Tüm dosyalardaki çakışmaları task ve yazar bilgisiyle listeler.
- **Git Conflict Radar: Sonraki çakışmaya git**
- **Git Conflict Radar: Aç / Kapat**

> Not: Tamamen anlık (push bildirimli) takip için GitHub'dan webhook alan bir sunucu gerekir. Eklenti bunun yerine uzak main'i periyodik olarak kontrol eder; `remoteCheckSeconds` ile bu süreyi kısaltabilirsiniz.

## Geliştirme

```bash
npm install
npm test            # birim testleri + gerçek git reposuyla analiz testleri
npm run test:e2e    # yüklü VS Code içinde uçtan uca test
npm run package     # .vsix üretir
```

F5 (**Run Git Conflict Radar**) ile Extension Development Host açılır. Denemek için örnek bir repo oluşturabilirsiniz:

```bash
./scripts/make-test-repo.sh /tmp/radar-demo
```

Eklenti açıkken başka birinin main'e merge yapmasını taklit etmek için şunu çalıştırın. En geç `remoteCheckSeconds` süresi içinde `util.js` için bildirim gelir:

```bash
./scripts/simulate-merge.sh /tmp/radar-demo
```
