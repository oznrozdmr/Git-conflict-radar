# Changelog

## 0.2.0

- Background watch of the remote main branch: when someone merges into `main`, only that branch is fetched and your branch is rescanned (`gitConflictRadar.remoteCheckSeconds`, default 60 s).
- Whole-branch scan: files you haven't opened are checked too; conflicts appear in the Problems panel.
- One summary notification per batch of new conflicts, with task and author.
- New command: **List all conflicts**. The status bar shows the branch-wide count.
- Background git commands never prompt for credentials.
- `autoFetchMinutes` was replaced by `remoteCheckSeconds`.

## 0.1.0

- Highlights lines changed both on your side (including unsaved edits) and on `main` since the merge-base.
- Hover and inline label with task ID, commit, author, date and the diff on `main`.
- Task ID from the commit message, falling back to the merged branch name.
- Problems panel warnings, notifications, status bar counter, side-by-side diff with `main`.
