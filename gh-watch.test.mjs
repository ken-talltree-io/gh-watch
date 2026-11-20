import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventsOf, threadsIn } from './gh-watch.mjs'

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

test('reports a merge or close once', () => {
  const merged = { state: 'closed', closed_at: '2026-11-05T00:00:00Z', pull_request: { merged_at: '2026-11-05T00:00:00Z' } }
  assert.deepEqual(eventsOf({ issue: merged, comments: [] }, since, 'ken').map(e => e[1]), ['merged'])
  assert.deepEqual(eventsOf({ issue: merged, comments: [] }, '2026-11-06T00:00:00Z', 'ken'), [])
})
