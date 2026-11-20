import { test } from 'node:test'
import assert from 'node:assert/strict'
import { age, eventsOf, headline, threadsIn } from './gh-watch.mjs'

const since = '2026-11-01T00:00:00Z'
const user = (login, type = 'User') => ({ login, type })

test('finds each issue and pull request once, comment links included', () => {
  assert.deepEqual(
    threadsIn('https://github.com/a/b/pull/3\nhttps://github.com/a/b/issues/4#issuecomment-9 https://github.com/a/b/pull/3'),
    ['https://github.com/a/b/pull/3', 'https://github.com/a/b/issues/4'],
  )
})

test("reports others' replies since the last poll, not mine, a bot's or older ones", () => {
  const events = eventsOf(
    {
      issue: { state: 'open' },
      comments: [
        { user: user('adam'), created_at: '2026-11-02T00:00:00Z', body: 'Looks good' },
        { user: user('ken'), created_at: '2026-11-03T00:00:00Z', body: 'Thanks' },
        { user: user('ci', 'Bot'), created_at: '2026-11-03T00:00:00Z', body: 'Coverage' },
        { user: user('adam'), created_at: '2026-10-30T00:00:00Z', body: 'Edited since' },
      ],
      reviews: [
        { user: user('maintainer'), submitted_at: '2026-11-04T00:00:00Z', state: 'CHANGES_REQUESTED', body: '' },
        { user: user('maintainer'), submitted_at: '2026-11-04T00:00:00Z', state: 'COMMENTED', body: '' },
      ],
    },
    since,
    'ken',
  )
  assert.deepEqual(events.map(e => e[1]), ['adam commented', 'maintainer reviewed (changes_requested)'])
})

test('reports a close once, but not a merge', () => {
  const closed = { state: 'closed', closed_at: '2026-11-05T00:00:00Z', closed_by: user('maintainer') }
  assert.deepEqual(eventsOf({ issue: closed, comments: [] }, since, 'ken').map(e => e[1]), ['closed by maintainer'])
  assert.deepEqual(eventsOf({ issue: closed, comments: [] }, '2026-11-06T00:00:00Z', 'ken'), [])
  assert.deepEqual(eventsOf({ issue: { ...closed, pull_request: { merged_at: closed.closed_at } }, comments: [] }, since, 'ken'), [])
})

test("a notification shows the session's first line, as plain text", () => {
  assert.equal(headline('\n## **Adam picked option 2 on #1847:** I\'d add the notes to the lot page\n\nDetail…'), "Adam picked option 2 on #1847: I'd add the notes to the lot page")
})

test('says how long ago in minutes, hours, then days', () => {
  const now = '2026-11-20T12:00:00Z'
  assert.deepEqual(['2026-11-20T11:55:00Z', '2026-11-20T09:00:00Z', '2026-11-17T12:00:00Z'].map(t => age(t, now)), ['5m', '3h', '3d'])
})
