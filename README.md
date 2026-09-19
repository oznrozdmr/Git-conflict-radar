# Git Conflict Radar

**Spot merge conflicts before you merge.** Git Conflict Radar highlights the lines you changed that were *also* changed on `main`. It tells you which task and commit changed them and warns you to rework your change. It also watches `main` in the background, so you hear about a teammate's merge as soon as it lands.

> 🇹🇷 Türkçe açıklama aşağıda: [Türkçe](#türkçe). The extension's UI messages are currently in Turkish.

## Features

- 🟧 **Highlighted conflict zones.** Risky lines get an orange background, a gutter icon and a scrollbar marker.
- 🏷️ **Who changed it, and why.** An inline label and the hover show the task ID (e.g. `PROJ-123`), commit, author, date and message. The hover also includes the exact diff that landed on `main`.
- ⚠️ **"Please rework" warnings.** Every conflict appears in the Problems panel, and new conflicts trigger a notification.
- ✍️ **Unsaved edits included.** The comparison uses the live editor buffer, so markers update as you type.
- 📡 **Background watch of `main`.** When someone merges into `main`, the extension notices within `remoteCheckSeconds` (default 60 s). It fetches only that branch, rescans your branch and notifies you, e.g. *"origin/main got new changes: PROJ-303 (Jane Doe). Conflict risk in 1 file: util.js. Please rework."*
- 🗂️ **Whole-branch scan.** Files you haven't opened are checked too. **List all conflicts** shows every risk across the branch.

## How it works

1. Find the merge-base of your `HEAD` and the main branch (`origin/main`, falling back to `main`/`master`).
2. Collect the lines changed on **main** since the merge-base (`git diff -U0 base main`) and the lines changed on **your side**: the editor buffer compared with the merge-base, covering committed, uncommitted and unsaved changes.
3. If both sides touch the same or adjacent lines (git's own conflict rule), the region is flagged. Identical changes on both sides are ignored.
4. On startup, branch switch, save and every update of `main`, all files changed on both sides are scanned.
5. The remote `main` is polled with a lightweight `git ls-remote`. Only when it moved is that single branch fetched. Background git calls never prompt for credentials.
6. The lines on `main` are traced with `git blame`. The task ID is taken from:
   1. the commit message (`PROJ-123: fix login`),
   2. otherwise the branch name of the merge commit that brought it in (`Merge branch 'feature/PROJ-123-login'`, `Merge pull request #5 from jane/feature/PROJ-123`),
   3. otherwise the merge message itself (e.g. PR number `#5`).

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitConflictRadar.mainBranch` | `origin/main` | Branch to compare against. Falls back to `main`, `master`. |
| `gitConflictRadar.taskPattern` | `[A-Z][A-Z0-9]+-\d+\|#\d+` | Regex used to extract task IDs. |
| `gitConflictRadar.taskUrlTemplate` | – | e.g. `https://jira.example.com/browse/{id}`. Makes task IDs clickable. |
| `gitConflictRadar.remoteCheckSeconds` | `60` | How often to check the remote main branch. `0` = off (minimum 5). |
| `gitConflictRadar.showNotifications` | `true` | Show a notification for new conflicts. |
| `gitConflictRadar.enabled` | `true` | Enable/disable the extension. |

Customize colors with `workbench.colorCustomizations`:

```json
"workbench.colorCustomizations": {
  "gitConflictRadar.conflictBackground": "#ff000030",
  "gitConflictRadar.conflictRuler": "#ff0000"
}
```

## Commands

- **Git Conflict Radar: List all conflicts**. Same as clicking the `⚠` status bar item.
- **Git Conflict Radar: Go to next conflict**
- **Git Conflict Radar: Compare with main**. Side-by-side diff with the file on `main`.
- **Git Conflict Radar: Fetch main**
- **Git Conflict Radar: Refresh**
- **Git Conflict Radar: Toggle**

## Requirements

- Git on your `PATH`
- A git repository with a `main` or `master` branch, local or remote

> Instant, push-style notifications would need a server receiving GitHub webhooks. This extension polls the remote instead; lower `remoteCheckSeconds` for faster updates.

---

## Türkçe

Siz kendi branch'inizde çalışırken **main dalında da değiştirilmiş satırları** merge'den önce gösterir.

- 🟧 **Renkli işaretleme:** Çakışma riski olan satırlar turuncu arka planla, gutter ikonuyla ve kaydırma çubuğunda işaretlenir.
- 🏷️ **Task bilgisi:** Satır sonunda ve hover'da o bölgeyi main'de hangi task'ın, hangi commit'in ve kimin değiştirdiği görünür. main'deki değişikliğin diff'i de hover'da yer alır.
- ⚠️ **Tekrar düzenleyin uyarısı:** Her çakışma Problems paneline uyarı olarak düşer. Yeni çakışmalarda bildirim çıkar.
- ✍️ **Kaydedilmemiş değişiklikler dahil:** Karşılaştırma editördeki güncel içerikle yapılır.
- 📡 **Arka planda main takibi:** Biri main'e merge yaptığında eklenti bunu en geç `remoteCheckSeconds` (varsayılan 60 sn) içinde fark eder. Sadece main'i fetch eder, branch'inizi tarar ve bildirim gösterir.
- 🗂️ **Tüm branch taranır:** Açmadığınız dosyalar da taranır. **Tüm çakışmaları listele** ile hepsini görebilirsiniz.

Task ID'si sırasıyla şuralardan aranır: commit mesajı, merge commit'teki branch adı (`feature/PROJ-123-login`), merge mesajı (PR numarası). Ayarlar ve komutlar yukarıdaki tablolarla aynıdır.

## Development / Geliştirme

```bash
npm install
npm test            # unit tests + analysis tests on a real git repo
npm run test:e2e    # end-to-end tests inside an installed VS Code
npm run package     # builds the .vsix
```

Try it with a demo repo, then simulate a teammate's merge:

```bash
./scripts/make-test-repo.sh /tmp/radar-demo      # open /tmp/radar-demo in VS Code
./scripts/simulate-merge.sh /tmp/radar-demo      # a notification arrives within ~1 min
```

## License

[MIT](LICENSE)
