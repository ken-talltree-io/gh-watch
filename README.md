# gh-watch

Wakes the [Claude Code](https://claude.com/claude-code) session that's waiting on a GitHub issue or pull request when
someone else replies, even weeks later.

- A `PostToolUse` hook watches each issue or PR a session opens or replies on (`gh issue|pr create|comment|review`),
  recording the session's id and folder in `~/.claude/gh-watch/watches.json`.
- launchd runs `gh-watch poll` every 15 minutes. For each watched thread with new comments, reviews, or a close by
  anyone but a bot, it resumes that session (`claude -p --resume`) with what happened, then shows a
  macOS notification. A closed thread stops being watched; a merged PR does too, waking no one.
- Your own comments count too, so a reply from GitHub Mobile or the web wakes the session, unless a session posted it:
  the hook records each comment link in a session's `gh` output (`~/.claude/gh-watch/posted.json`).
- A woken session runs in plan mode: it reads the thread and the code and proposes what to do, changing nothing.
  `gh-watch resume`, or clicking the notification, opens it, so you can read its answer and tell it to go ahead.
- A session still running isn't woken, as a second process would continue a copy of it the open one never sees: the
  notification carries the reply instead. Opening it attaches to it if it's a background job (`claude attach`), or
  brings its Terminal tab forward; one that isn't running is resumed in its folder. Which sessions are running comes
  from `~/.claude/sessions`, Claude Code's own internal record (`claude agents --json` leaves out interactive ones).

Needs macOS, Node 22+, `gh` signed in, and `claude`. With `brew install terminal-notifier`, clicking a notification
opens Terminal on the woken session (or, when it couldn't be woken, the thread on GitHub); without it, a click does
nothing useful, as macOS can't attach an action to an AppleScript notification.

## Install

```sh
git clone https://github.com/ken-talltree-io/gh-watch && cd gh-watch && node gh-watch.mjs install
```

This adds the hook to `~/.claude/settings.json`, links `~/.local/bin/gh-watch`, and loads the launchd job. Run it
again after moving the folder. New sessions then pick up the hook.

## Use

| Command | Does |
|---|---|
| `gh-watch resume [thread]` | Opens the session last woken, or the one watching a thread (its URL or `owner/repo#n`): attached, its tab, or resumed |
| `gh-watch list` | Each watched thread by the session waiting on it: its title, and how long it's been quiet or what it last woke for |
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
