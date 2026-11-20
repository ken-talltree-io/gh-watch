#!/usr/bin/env node
// gh-watch: wakes the Claude Code session waiting on a GitHub issue or pull request when someone else replies.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.GH_WATCH_HOME ?? join(homedir(), '.claude', 'gh-watch')
const file = join(home, 'watches.json')
const last = join(home, 'last.json')
const label = 'io.talltree.gh-watch'

const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/g
export const threadsIn = text => [...new Set([...text.matchAll(pattern)].map(m => m[0]))]

// What happened on a thread since a time, by anyone but me or a bot, oldest first
export function eventsOf({ issue, comments, reviews = [], reviewComments = [] }, since, me) {
  const others = u => u && u.login !== me && u.type !== 'Bot'
  const after = t => t && t > since
  const events = [
    ...comments.filter(c => others(c.user) && after(c.created_at)).map(c => [c.created_at, `${c.user.login} commented`, c.body]),
    ...reviews
      .filter(r => others(r.user) && after(r.submitted_at) && (r.body || r.state !== 'COMMENTED'))
      .map(r => [r.submitted_at, `${r.user.login} reviewed (${r.state.toLowerCase()})`, r.body]),
    ...reviewComments
      .filter(c => others(c.user) && after(c.created_at))
      .map(c => [c.created_at, `${c.user.login} commented on ${c.path}:${c.line ?? c.original_line ?? ''}`, c.body]),
  ].sort(([a], [b]) => a.localeCompare(b))
  // A merge ends the watch without waking anyone: it's what the session was waiting for
  if (issue.state === 'closed' && after(issue.closed_at) && !issue.pull_request?.merged_at)
    events.push([issue.closed_at, `closed by ${issue.closed_by?.login ?? 'someone'}`, ''])
  return events
}

export const promptFor = (url, title, events) =>
  `GitHub activity on ${url} ("${title}"), which this session is waiting on:\n\n` +
  events.map(([at, what, body]) => `${what} at ${at}:\n${(body ?? '').slice(0, 4000)}`.trim()).join('\n\n') +
  '\n\nThis session may be days old: re-read the thread and the code it touches first. Then say in a few lines what this reply' +
  ' needs and what you propose to do: you were woken unattended, so act only once the person resumes this session and agrees.'

const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
const save = watches => {
  mkdirSync(home, { recursive: true })
  writeFileSync(file, JSON.stringify(watches, null, 2) + '\n')
}
const log = msg => {
  mkdirSync(home, { recursive: true })
  appendFileSync(join(home, 'log'), `${new Date().toISOString()} ${msg}\n`)
}
const gh = (args, cwd) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const api = path => JSON.parse(gh(['api', path]))
const notify = (title, msg) =>
  spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, msg])

function add(urls, session, cwd) {
  const watches = load()
  const since = new Date().toISOString()
  for (const url of urls) watches[url] = { session, cwd, since: watches[url]?.since ?? since, added: watches[url]?.added ?? since }
  save(watches)
}

// A PostToolUse hook: a gh command that opens or replies on an issue or pull request watches it for this session
function hook() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input.tool_input?.command ?? ''
  const m = command.match(/\bgh\s+(issue|pr)\s+(create|comment|review)\b\s*(\S+)?/)
  if (!m) return
  let urls = threadsIn(`${command}\n${JSON.stringify(input.tool_response ?? '')}`)
  if (!urls.length) {
    const arg = /^#?\d+$/.test(m[3] ?? '') ? [m[3].replace('#', '')] : []
    try {
      urls = threadsIn(gh([m[1], 'view', ...arg, '--json', 'url', '--jq', '.url'], input.cwd))
    } catch {
      return
    }
  }
  add(urls, input.session_id, input.cwd)
}

function poll(dryRun) {
  const watches = load()
  if (!Object.keys(watches).length) return
  const me = gh(['api', 'user', '--jq', '.login']).trim()
  // Plan mode by default: a session woken unattended reads and answers, but changes nothing until you resume it
  const extra = (process.env.GH_WATCH_CLAUDE_ARGS ?? '--permission-mode plan').split(' ').filter(Boolean)
  for (const [url, w] of Object.entries(watches)) {
    const [, repo, kind, n] = [...url.matchAll(pattern)][0]
    const now = new Date().toISOString()
    let facts
    try {
      const issue = api(`repos/${repo}/issues/${n}`)
      const comments = api(`repos/${repo}/issues/${n}/comments?since=${w.since}&per_page=100`)
      const pr = kind === 'pull'
      facts = {
        issue,
        comments,
        reviews: pr ? api(`repos/${repo}/pulls/${n}/reviews?per_page=100`) : [],
        reviewComments: pr ? api(`repos/${repo}/pulls/${n}/comments?since=${w.since}&per_page=100`) : [],
      }
    } catch (e) {
      log(`${url}: could not read it: ${e.stderr?.trim() || e.message}`)
      continue
    }
    const events = eventsOf(facts, w.since, me)
    if (events.length) {
      const prompt = promptFor(url, facts.issue.title, events)
      if (dryRun) console.log(`--- would resume ${w.session} in ${w.cwd}\n${prompt}\n`)
      else if (!existsSync(w.cwd)) {
        log(`${url}: ${w.cwd} is gone, so session ${w.session} can't be resumed`)
        notify('gh-watch', `${events.at(-1)[1]} on ${url}; its session's folder is gone`)
      } else {
        log(`${url}: resuming ${w.session} for ${events.map(e => e[1]).join(', ')}`)
        const r = spawnSync('claude', ['-p', '--resume', w.session, ...extra, prompt], { cwd: w.cwd, encoding: 'utf8', timeout: 30 * 60e3 })
        const said = (r.stdout || r.stderr || r.error?.message || '').trim()
        log(`${url}: session exited ${r.status}: ${said.slice(0, 1000)}`)
        writeFileSync(last, JSON.stringify({ url, ...w }))
        notify(`${events.at(-1)[1]} on ${repo}#${n}`, `Run gh-watch resume to pick it up. ${said.slice(0, 150)}`)
      }
    }
    if (dryRun) continue
    if (facts.issue.state === 'closed') delete watches[url]
    else watches[url] = { ...w, since: now }
  }
  if (!dryRun) save(watches)
}

// Opens the session last woken (or the one watching a URL) where it ran, to read its answer and go on
function resume(url) {
  const w = url ? load()[url] : existsSync(last) && JSON.parse(readFileSync(last, 'utf8'))
  if (!w) throw new Error(url ? `Not watching ${url}` : 'No session has been woken yet')
  process.exit(spawnSync('claude', ['--resume', w.session], { cwd: w.cwd, stdio: 'inherit' }).status ?? 1)
}

// The PostToolUse hook, in ~/.claude/settings.json, so every session watches what it opens or replies on
function addHook(script) {
  const path = join(homedir(), '.claude', 'settings.json')
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  const command = `${script} hook`
  const post = ((settings.hooks ??= {}).PostToolUse ??= [])
  if (post.some(h => h.hooks?.some(x => x.command?.endsWith(' hook') && x.command.includes('gh-watch')))) return
  post.push({ matcher: 'Bash', hooks: [{ type: 'command', command }] })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
}

function install() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const script = fileURLToPath(import.meta.url)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${script}</string><string>poll</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>StartInterval</key><integer>${Number(process.env.GH_WATCH_SECONDS ?? 900)}</integer>
  <key>StandardOutPath</key><string>${join(home, 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${join(home, 'launchd.log')}</string>
</dict></plist>
`,
  )
  addHook(script)
  const bin = join(homedir(), '.local', 'bin', 'gh-watch')
  rmSync(bin, { force: true })
  symlinkSync(script, bin)
  const domain = `gui/${process.getuid()}`
  spawnSync('launchctl', ['bootout', `${domain}/${label}`])
  execFileSync('launchctl', ['bootstrap', domain, plist])
  console.log(`Hook added to ~/.claude/settings.json; ${bin} links here`)
  console.log(`Polling every ${Number(process.env.GH_WATCH_SECONDS ?? 900)}s: ${plist}`)
}

const [cmd, ...args] = process.argv.slice(2)
const commands = {
    hook,
    poll: () => poll(args.includes('--dry-run')),
    add: () => {
      if (!process.env.CLAUDE_CODE_SESSION_ID) throw new Error('Run add from inside a Claude Code session')
      add(args.filter(a => !a.startsWith('--')).flatMap(threadsIn), process.env.CLAUDE_CODE_SESSION_ID, process.cwd())
    },
    remove: () => {
      const watches = load()
      for (const url of args) delete watches[url]
      save(watches)
    },
    list: () =>
      Object.entries(load()).forEach(([url, w]) => console.log(`${url}  session ${w.session}  since ${w.since}  in ${w.cwd}`)),
    resume: () => resume(args[0]),
    install,
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  if (commands[cmd]) commands[cmd]()
  else console.log('Usage: gh-watch install | list | resume [url] | add <url>… | remove <url>… | poll [--dry-run] | hook')
