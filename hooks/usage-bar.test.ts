import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const LIMITS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 15, resetsAt: '2026-10-14T10:00:00Z' },
  { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-11T12:13:00Z' },
]

// Antwort des Plan-Endpunkts in seiner heutigen Form: flache Fenster null, alles im `limits`-Array.
const PLAN = {
  five_hour: null,
  seven_day: null,
  limits: [
    { kind: 'session', percent: 44, resets_at: '2026-10-11T12:13:00Z' },
    { kind: 'weekly_all', percent: 16, resets_at: '2026-10-14T10:00:00Z' },
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 71, resets_at: '2026-10-15T08:00:00Z' },
  ],
}

type Setup = { rateLimits?: SessionRateLimit[]; plan?: unknown; status?: number; store?: Record<string, unknown> }

const start = async ($: Engine, on: On, setup: Setup = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, setup.store)
  const fetched: string[] = []

  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: setup.rateLimits ?? [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.authorize', () => ({ value: { handle: 'test-handle', kind: 'bearer' as const } }))
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    const status = setup.status ?? 200

    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(setup.plan ?? PLAN) } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  return { clock, fetched }
}

const mountBand = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })

test('Terminal: durchgezogene Linien statt Punkte, Desktop: SVG-Balken', async ($, on) => {
  await start($, on, { rateLimits: LIMITS, plan: {} })

  const terminal = await mountBand($, 'terminal')
  const fiveHour = await terminal.find({ key: 'five_hour' })
  expect(fiveHour?.text).toContain('5h')
  expect(fiveHour?.text).toContain('43%')
  expect(fiveHour?.text).toContain('2h 13m')
  expect(fiveHour?.text).toContain('━')
  expect(fiveHour?.text).not.toContain('░')
  expect((await terminal.find({ key: 'seven_day' }))?.text).toContain('3d 0h')

  const desktop = await mountBand($, 'desktop')
  const bars = await desktop.findAll({ type: 'Svg' })
  expect(bars.map(bar => bar.props.alt)).toEqual(['5h: 43% verbraucht', 'Woche: 15% verbraucht'])
  expect(String(bars[0]?.props.source)).toContain('<rect')
})

test('Fable-Limit kommt vom Plan-Endpunkt und lässt sich ein- und ausblenden', async ($, on) => {
  const { fetched } = await start($, on)
  expect(fetched).toEqual(['https://api.anthropic.com/api/oauth/usage'])

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    const fable = await ui.find({ key: 'fable' })
    expect(fable?.text).toContain('Fable')
    expect(fable?.text).toContain('71%')
    expect((await ui.find({ key: 'five_hour' }))?.text).toContain('44%')

    await ui.press({ key: 'toggle-fable' })
    expect(await ui.find({ key: 'fable' })).toBeUndefined()
    expect((await ui.find({ key: 'toggle-fable' }))?.props.label).toBe('○ Fable')

    await ui.press({ key: 'toggle-fable' })
    expect((await ui.find({ key: 'fable' }))?.text).toContain('71%')
  }
})

test('/usage-bar fable schaltet um und merkt sich die Wahl', async ($, on) => {
  await start($, on)

  const run = (args: string) =>
    $.command.run({
      command: 'usage-bar',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  expect((await run('fable')).text).toBe('Fable-Limit ausgeblendet.')
  expect(await (await mountBand($, 'desktop')).find({ key: 'fable' })).toBeUndefined()

  expect((await run('fable')).text).toBe('Fable-Limit eingeblendet.')
  expect((await run('')).text).toContain('/usage-bar fable')
})

test('session.measure aktualisiert die Leiste und behält Fable', async ($, on) => {
  await start($, on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: '2026-10-11T10:30:00Z' }],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    const fiveHour = await ui.find({ key: 'five_hour' })

    expect(fiveHour?.text).toContain('91%')
    expect(fiveHour?.text).toContain('30m')
    expect((await ui.find({ key: 'fable' }))?.text).toContain('71%')
  }
})

test('ohne frische Daten wird der zuletzt gespeicherte Stand gezeigt', async ($, on) => {
  await start($, on, {
    status: 429,
    store: {
      last: { limits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-11T11:00:00Z' }], at: NOW - 20 * 60_000, isLive: true },
    },
  })

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)

    expect((await ui.find({ key: 'five_hour' }))?.text).toContain('60%')
    expect((await ui.find({ key: 'usage-bar' }))?.text).toContain('Stand vor 20m')
    expect((await ui.find({ key: 'usage-bar' }))?.text).toContain('Fable: keine Daten')
  }
})
