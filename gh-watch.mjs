#!/usr/bin/env node
// gh-watch: wakes the Claude Code session waiting on a GitHub issue or pull request when someone else replies.
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const home = process.env.GH_WATCH_HOME ?? join(homedir(), '.claude', 'gh-watch')
const file = join(home, 'watches.json')
const last = join(home, 'last.json')
const label = 'io.talltree.gh-watch'

const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/g
export const threadsIn = text => [...new Set([...text.matchAll(pattern)].map(m => m[0]))]
const refOf = url => url.replace(pattern, '$1#$3')

// How long ago, said short: 5m, 3h, 2d
export const age = (from, now) => {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 60e3))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// What happened on a thread since a time, by anyone but me or a bot, oldest first
// A comment of mine counts unless a session posted it (posted: the ids the hook saw in sessions' gh output), so a reply
// from my phone or the web wakes the session as anyone's would
export function eventsOf({ issue, comments, reviews = [], reviewComments = [] }, since, me, posted = new Set()) {
  const others = u => u && u.login !== me && u.type !== 'Bot'
  const after = t => t && t > since
  const mine = c => c.user?.login === me && !posted.has(String(c.id))
  const events = [
    ...comments
      .filter(c => (others(c.user) || mine(c)) && after(c.created_at))
      .map(c => [c.created_at, mine(c) ? 'you commented' : `${c.user.login} commented`, c.body]),
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
  '\n\nThis session may be days old: re-read the thread and the code it touches first. You were woken unattended, so act only' +
  ' once the person resumes this session and agrees. Begin your answer with one line, under 100 characters, that a' +
  ' notification shows: what this needs and what you propose, e.g. "Adam picked option 2: I\'d add the notes to the lot' +
  ' page" or "Nothing needed: the reviewer approved". Then the detail, in a few lines.'

// The first line a session said, as plain text, for a notification
export const headline = said => (said.split('\n').find(l => l.trim()) ?? '').replace(/^[\s#>]+/, '').replace(/[*_`]/g, '').trim().slice(0, 150)

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
// Homebrew's terminal-notifier runs a command when a notification is clicked; osascript's can't
const notifier = '/opt/homebrew/bin/terminal-notifier'
const clickable = existsSync(notifier)

// A notification: what happened (the latest, and how many more), on which thread, then what to do, which a click does
function notify(events, thread, msg, click) {
  const title = events.at(-1)[1] + (events.length > 1 ? ` (+${events.length - 1} more)` : '')
  // One macOS refuses (its notifications not allowed in System Settings) falls back to osascript's, which can't be clicked
  if (!clickable || spawnSync(notifier, ['-title', title, '-subtitle', thread, '-message', msg, '-group', thread, ...click]).status !== 0)
    spawnSync('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
      '-e', 'end run',
      title, thread, msg,
    ])
}
// A click that opens Terminal on the session watching a URL
// A click runs gh-watch's click command, by node's full path: a notification's command gets no shell PATH
const clickOn = url => ['-execute', `${process.execPath} ${fileURLToPath(import.meta.url)} click ${url}`]

// The session still running, if it is: its process, kind ('bg' or 'interactive') and background job id, from Claude
// Code's own record of running sessions (~/.claude/sessions, internal; claude agents --json leaves out interactive ones)
function running(session) {
  const dir = join(homedir(), '.claude', 'sessions')
  const alive = pid => {
    try {
      return process.kill(pid, 0)
    } catch (e) {
      return e.code === 'EPERM'
    }
  }
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (s.sessionId === session && alive(s.pid)) return s
    } catch {
      // a record being written or removed as we read it
    }
  }
}

// The process attached to a background job (claude attach <id or name>) in a terminal, if one is
function attached(s) {
  const lines = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
  const names = [s.jobId, s.name].filter(Boolean)
  const line = lines.find(l => {
    const m = l.trim().match(/^(\d+) \S*claude attach (.+)$/)
    return m && names.includes(m[2].replace(/^["']|["']$/g, ''))
  })
  return line && Number(line.trim().split(' ')[0])
}

// Brings forward the Terminal tab a process runs in; false if it's in no Terminal tab
function focusTab(pid) {
  const tty = `/dev/${execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()}`
  const script = [
    'on run argv',
    'tell application "Terminal"',
    'repeat with w in windows',
    // a window with no tabs (a settings or about window) can't be read: skip it
    'try',
    'repeat with t in tabs of w',
    'if tty of t is (item 1 of argv) then',
    'set selected of t to true',
    'set index of w to 1',
    'activate',
    'return "found"',
    'end if',
    'end repeat',
    'end try',
    'end repeat',
    'end tell',
    'end run',
  ]
  return spawnSync('osascript', [...script.flatMap(l => ['-e', l]), tty], { encoding: 'utf8' }).stdout.trim() === 'found'
}

const watchOf = thread => {
  const watches = load()
  const url = thread && Object.keys(watches).find(u => u === thread || refOf(u) === thread)
  const w = thread ? url && { url, ...watches[url] } : existsSync(last) && JSON.parse(readFileSync(last, 'utf8'))
  if (!w) throw new Error(thread ? `Not watching ${thread}` : 'No session has been woken yet')
  return w
}

function add(urls, session, cwd) {
  const watches = load()
  const since = new Date().toISOString()
  for (const url of urls) watches[url] = { session, cwd, since: watches[url]?.since ?? since, added: watches[url]?.added ?? since }
  save(watches)
}

// The threads a command's gh calls acted on: a URL given as one's argument, or one gh printed alone on a line (what it
// created or commented on); never another URL the command or its output happens to mention
export function actedOn(command, output) {
  const calls = [...command.matchAll(/\bgh\s+(issue|pr)\s+(create|comment|review)\b\s*(\S+)?/g)]
  const printed = output.split('\n').map(l => l.trim()).filter(l => threadsIn(l)[0] && l.startsWith(threadsIn(l)[0]) && !/\s/.test(l))
  return { calls, urls: [...new Set([...calls.flatMap(c => threadsIn(c[3] ?? '')), ...printed.flatMap(threadsIn)])] }
}

// The comments a session's gh output names: what it posted (or read), never a reply of mine to wake it for
export const commentsIn = text => [...text.matchAll(/#issuecomment-(\d+)/g)].map(m => m[1])
const postedFile = join(home, 'posted.json')
const posted = () => new Set(existsSync(postedFile) ? JSON.parse(readFileSync(postedFile, 'utf8')) : [])
function remember(ids) {
  if (!ids.length) return
  mkdirSync(home, { recursive: true })
  writeFileSync(postedFile, JSON.stringify([...new Set([...posted(), ...ids])].slice(-5000)))
}

// A PostToolUse hook: a gh command that opens or replies on an issue or pull request watches it for this session
function hook() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const response = input.tool_response
  const output = typeof response === 'string' ? response : (response?.stdout ?? '')
  const command = input.tool_input?.command ?? ''
  if (/\bgh\b/.test(command)) remember(commentsIn(output))
  const { calls, urls } = actedOn(command, output)
  if (!calls.length) return
  if (!urls.length) {
    // gh printed none (a review): ask gh which thread its argument, or the branch, names
    const [, kind, , arg] = calls[0]
    const repo = (input.tool_input.command.match(/(?:-R|--repo)[ =](\S+)/) ?? [])[1]
    try {
      urls.push(...threadsIn(gh([kind, 'view', ...(/^#?\d+$/.test(arg ?? '') ? [arg.replace('#', '')] : []), ...(repo ? ['-R', repo] : []), '--json', 'url', '--jq', '.url'], input.cwd)))
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
  const seen = posted()
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
    const events = eventsOf(facts, w.since, me, seen)
    let woke
    if (events.length) {
      const thread = `${refOf(url)}: ${facts.issue.title}`
      const prompt = promptFor(url, facts.issue.title, events)
      if (dryRun) console.log(`--- would resume ${w.session} in ${w.cwd}\n${prompt}\n`)
      else if (!existsSync(w.cwd)) {
        log(`${url}: ${w.cwd} is gone, so session ${w.session} can't be resumed`)
        notify(events, thread, "Its session's folder is gone, so reply on GitHub yourself", ['-open', url])
        woke = { at: now, said: `${events.at(-1)[1]}, but its session's folder is gone` }
      } else if (running(w.session)) {
        // A session still running isn't woken: a second process would continue a copy of it the open one never sees
        log(`${url}: session ${w.session} is running, so the reply goes to you, not to it`)
        notify(events, thread, `${headline(events.at(-1)[2] || '') || events.at(-1)[1]} · click to open its session`, clickOn(url))
        woke = { at: now, said: `its session was running: ${events.at(-1)[1]}, sent to you` }
      } else {
        log(`${url}: resuming ${w.session} for ${events.map(e => e[1]).join(', ')}`)
        const r = spawnSync('claude', ['-p', '--resume', w.session, ...extra, prompt], { cwd: w.cwd, encoding: 'utf8', timeout: 30 * 60e3 })
        const said = (r.stdout || r.stderr || r.error?.message || '').trim()
        log(`${url}: session exited ${r.status}: ${said.slice(0, 1000)}`)
        writeFileSync(last, JSON.stringify({ url, ...w }))
        woke = { at: now, said: r.status === 0 ? headline(said) : `${events.at(-1)[1]}; the session failed (exit ${r.status})` }
        if (r.status === 0) notify(events, thread, `${headline(said)} · ${clickable ? 'click' : 'run gh-watch resume'} to resume`, clickOn(url))
        else notify(events, thread, `The session failed (exit ${r.status}): see ~/.claude/gh-watch/log`, ['-open', url])
      }
    }
    if (dryRun) continue
    if (facts.issue.state === 'closed') delete watches[url]
    else watches[url] = { ...w, since: now, title: facts.issue.title, ...(woke && { woke }) }
  }
  if (!dryRun) save(watches)
}

// Opens the session last woken (or the one watching a URL) where it ran, to read its answer and go on
// Opens the session last woken (or the one watching a thread) where it is: attached if it runs in the background, its
// Terminal tab if it's open in one, else resumed in its folder
function resume(thread) {
  const w = watchOf(thread)
  const s = running(w.session)
  if (s?.kind === 'interactive') {
    if (!focusTab(s.pid)) console.log(`Session ${w.session.slice(0, 8)} is open in another terminal app: switch to it there`)
    return
  }
  const pid = s && attached(s)
  if (pid && focusTab(pid)) return console.log(`Session ${w.session.slice(0, 8)} is attached in another Terminal tab: brought it forward`)
  const args = s ? ['attach', s.jobId] : ['--resume', w.session]
  process.exit(spawnSync('claude', args, { cwd: w.cwd, stdio: 'inherit' }).status ?? 1)
}

// A notification clicked: the Terminal tab the session is open or attached in is brought forward, else Terminal opens
// a tab on gh-watch resume
function click(thread) {
  const w = watchOf(thread)
  const s = running(w.session)
  if (s?.kind === 'interactive') {
    if (!focusTab(s.pid)) spawnSync('open', [w.url])
    return
  }
  const pid = s && attached(s)
  if (pid && focusTab(pid)) return
  const command = `${fileURLToPath(import.meta.url)} resume ${w.url}`
  spawnSync('osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', command])
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

// Each watched thread, by the session waiting on it: its title, and how long it's been quiet or what it last woke for
async function list() {
  const watches = Object.entries(load())
  if (!watches.length) return console.log('Not watching anything: a session watches each issue or PR it opens or replies on with gh')
  const run = promisify(execFile)
  // A title the poll hasn't stored yet is fetched
  const titles = await Promise.all(
    watches.map(([url, w]) =>
      w.title ?? run('gh', ['api', `repos/${refOf(url).replace('#', '/issues/')}`, '--jq', '.title']).then(r => r.stdout.trim(), () => '?'),
    ),
  )
  const now = new Date().toISOString()
  const width = Math.max(...watches.map(([url]) => refOf(url).length))
  const groups = Map.groupBy(watches.map(([url, w], i) => ({ url, w, title: titles[i] })), ({ w }) => `${w.session} ${w.cwd}`)
  for (const rows of groups.values()) {
    const { session, cwd } = rows[0].w
    console.log(`\n${cwd.replace(homedir(), '~')} · session ${session.slice(0, 8)} · ${rows.length} thread${rows.length > 1 ? 's' : ''}`)
    for (const { url, w, title } of rows) {
      const state = w.woke ? `woke ${age(w.woke.at, now)} ago: ${w.woke.said}` : `quiet ${age(w.added, now)}`
      console.log(`  ${refOf(url).padEnd(width)}  ${title.length > 60 ? title.slice(0, 59) + '…' : title}  · ${state}`)
    }
  }
  console.log('\ngh-watch resume <owner/repo#n> opens the session waiting on a thread')
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
    list,
    resume: () => resume(args[0]),
    click: () => click(args[0]),
    install,
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  if (commands[cmd]) commands[cmd]()
  else console.log('Usage: gh-watch install | list | resume [url or owner/repo#n] | add <url>… | remove <url>… | poll [--dry-run] | hook')
