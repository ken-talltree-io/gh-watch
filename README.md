# gh-watch

Wakes the [Claude Code](https://claude.com/claude-code) session that's waiting on a GitHub issue or pull request when
someone else replies, even weeks later.

- A `PostToolUse` hook watches each issue or PR a session opens or replies on (`gh issue|pr create|comment|review`),
  recording the session's id and folder in `~/.claude/gh-watch/watches.json`.
- launchd runs `gh-watch poll` every 15 minutes. For each watched thread with new comments, reviews, or a close or
  merge by anyone but you or a bot, it resumes that session (`claude -p --resume`) with what happened, then shows a
  macOS notification. A closed thread stops being watched.
- A woken session runs in plan mode: it reads the thread and the code and proposes what to do, changing nothing.
  `gh-watch resume` opens it, so you can read its answer and tell it to go ahead.

Needs macOS, Node 22+, `gh` signed in, and `claude`.

## Install

```sh
git clone https://github.com/ken-talltree-io/gh-watch && cd gh-watch && node gh-watch.mjs install
```

This adds the hook to `~/.claude/settings.json`, links `~/.local/bin/gh-watch`, and loads the launchd job. Run it
again after moving the folder. New sessions then pick up the hook.

## Use

| Command | Does |
|---|---|
| `gh-watch resume [url]` | Opens the session last woken, or the one watching `url`, in its folder |
| `gh-watch list` | Each watched thread, its session and folder |
| `gh-watch add <url>…` | Watches a thread for the current session (run it inside one) |
| `gh-watch remove <url>…` | Stops watching |
| `gh-watch poll [--dry-run]` | Polls now; `--dry-run` prints what it would send and changes nothing |

`~/.claude/gh-watch/log` records each wake-up and the session's answer. Settings: `GH_WATCH_SECONDS` (install, default
900), `GH_WATCH_CLAUDE_ARGS` (the woken session's flags, default `--permission-mode plan`), `GH_WATCH_HOME`.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/io.talltree.gh-watch; rm ~/Library/LaunchAgents/io.talltree.gh-watch.plist ~/.local/bin/gh-watch
```

Then remove the `gh-watch` hook from `~/.claude/settings.json`.

## Limits

- A woken session that's also open in a terminal gets the reply appended out of sight. Resume it to see it.
- A session whose folder was removed (a deleted worktree) can't be resumed. You get a notification instead.
- Each wake-up is a model turn. Bots and your own comments are skipped.
