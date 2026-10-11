import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-bar', key: 'snapshot' } as const, null)
const showFable = atom({ plugin: 'usage-bar', key: 'showFable' } as const, true)

const MINUTE = 60_000

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Woche', fable: 'Fable', spend_limit: 'Limit' }
const ORDER = ['five_hour', 'seven_day', 'fable']

// Derselbe Endpunkt, den /usage liest: liefert neben 5h und Woche auch die Wochenlimits pro Modell (Fable).
const PLAN_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FETCH_GAP = 3 * MINUTE
const FETCH_BACKOFF = 15 * MINUTE

// Balkenfarben fürs SVG: lesbar auf hellem wie dunklem Hintergrund.
const HEX: Record<'success' | 'warning' | 'error', string> = {
  success: '#2ea043',
  warning: '#d29922',
  error: '#e5534b',
}
const TRACK = '#8b949e'
const BAR_HEIGHT = 12

// Nur Modul-Buchhaltung für den Abruf; ein Reload darf sie zurücksetzen.
let nextFetchAt = 0
let isFetching = false

const rank = (kind: string) => {
  const i = ORDER.indexOf(kind)

  return i === -1 ? ORDER.length : i
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

const resetAtOf = (limit: Limit) => (limit.resetsAt ? Date.parse(limit.resetsAt) : NaN)

const percentOf = (limit: Limit, now: number) => {
  const resetAt = resetAtOf(limit)

  // Ein gespeicherter Stand, dessen Fenster inzwischen zurückgesetzt wurde, zählt als 0 %.
  return !Number.isNaN(resetAt) && resetAt <= now ? 0 : limit.percentUsed
}

const colorFor = (percent: number) => (percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success')

const formatDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`

  return `${mins}m`
}

const resetText = (limit: Limit, now: number) => {
  const resetAt = resetAtOf(limit)

  if (Number.isNaN(resetAt)) return ''

  return resetAt <= now ? 'zurückgesetzt' : `↻ ${formatDuration(resetAt - now)}`
}

// Die Füllung wird auf die abgerundete Spur zugeschnitten, so bleibt auch ein kleiner Stand maßstabsgetreu.
const svgBar = (percent: number, color: string, width: number) => {
  const fill = Math.round((clamp(percent, 0, 100) / 100) * width)
  const track = `<rect x="0" y="0" width="${width}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}" viewBox="0 0 ${width} ${BAR_HEIGHT}">` +
    `<defs><clipPath id="t">${track}</clipPath></defs>` +
    `<g clip-path="url(#t)">` +
    `<rect x="0" y="0" width="${width}" height="${BAR_HEIGHT}" fill="${TRACK}" fill-opacity="0.28"/>` +
    (fill > 0 ? `<rect x="0" y="0" width="${fill}" height="${BAR_HEIGHT}" fill="${color}"/>` : '') +
    '</g></svg>'
  )
}

const merge = (current: readonly Limit[], fresh: readonly Limit[]) => [
  ...current.filter(old => !fresh.some(limit => limit.kind === old.kind)),
  ...fresh,
]

const fromSession = (limits: readonly SessionRateLimit[]): Limit[] =>
  limits.map(({ kind, percentUsed, resetsAt }) => (resetsAt ? { kind, percentUsed, resetsAt } : { kind, percentUsed }))

const withCost = (snap: Snapshot, costUsd: number | undefined): Snapshot => {
  const { costUsd: _, ...rest } = snap

  return costUsd === undefined ? rest : { ...rest, costUsd }
}

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === 'object' && value !== null && Array.isArray((value as Snapshot).limits) && typeof (value as Snapshot).at === 'number'

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

// Liest die Antwort des Plan-Endpunkts: die flachen Fenster (`five_hour`, `seven_day`, `seven_day_fable`)
// und das `limits`-Array (`session`, `weekly_all`, `weekly_scoped` mit Modellname), je nachdem was gefüllt ist.
const parsePlanUsage = (text: string): Limit[] => {
  let body: Record<string, unknown> | null

  try {
    body = obj(JSON.parse(text))
  } catch {
    return []
  }

  if (!body) return []

  const found = new Map<string, Limit>()
  const take = (kind: string, value: unknown, field: 'utilization' | 'percent') => {
    const w = obj(value)
    const pct = w?.[field]

    if (!w || typeof pct !== 'number' || !Number.isFinite(pct) || found.has(kind)) return

    const reset = w.resets_at
    const resetsAt =
      typeof reset === 'string' ? reset : typeof reset === 'number' ? new Date(reset * 1000).toISOString() : undefined
    found.set(kind, resetsAt ? { kind, percentUsed: pct, resetsAt } : { kind, percentUsed: pct })
  }

  for (const row of Array.isArray(body.limits) ? body.limits : []) {
    const r = obj(row)
    const model = obj(obj(r?.scope)?.model)?.display_name

    if (r?.kind === 'session') take('five_hour', r, 'percent')
    if (r?.kind === 'weekly_all') take('seven_day', r, 'percent')
    if (r?.kind === 'weekly_scoped' && typeof model === 'string' && /fable/i.test(model)) take('fable', r, 'percent')
  }

  take('five_hour', body.five_hour, 'utilization')
  take('seven_day', body.seven_day, 'utilization')
  take('fable', body.seven_day_fable, 'utilization')

  return [...found.values()]
}

const store = async ($: EngineInterface, next: Snapshot) => {
  await update($, snapshot, () => next)
  if (next.limits.length > 0) await $.store.set('last', next)
}

const remember = async ($: EngineInterface, fresh: readonly Limit[], costUsd: number | undefined) => {
  const at = await $.clock.now()
  const current = (await read($, snapshot)) ?? { limits: [], at, isLive: true }
  const cost = costUsd ?? current.costUsd

  if (fresh.length === 0) {
    // Kein frischer Stand: den bisherigen (ggf. gespeicherten) behalten, nur die Kosten nachziehen.
    await update($, snapshot, () => withCost(current, cost))

    return
  }

  // Ein gespeicherter Stand aus einer früheren Session wird ersetzt, ein frischer pro Fenster aktualisiert.
  const live = current.isLive ? current.limits : []
  await store($, withCost({ limits: merge(live, fresh), at, isLive: true }, cost))
}

const refreshPlan = async ($: EngineInterface) => {
  const now = await $.clock.now()

  if (isFetching || now < nextFetchAt) return

  isFetching = true
  nextFetchAt = now + FETCH_GAP

  try {
    // Ein Handle auf den Login der Session; das Token selbst erreicht die Mod nie.
    const auth = await $.session.authorize()

    if (auth?.kind !== 'bearer') {
      // API-Key oder kein claude.ai-Login: der Endpunkt kennt dann keine Plan-Limits.
      nextFetchAt = Number.POSITIVE_INFINITY

      return
    }

    const res = await $.http.fetch(PLAN_USAGE_URL, {
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      auth: auth.handle,
    })

    if (!res.ok) {
      if ([401, 403, 429].includes(res.status)) nextFetchAt = now + FETCH_BACKOFF

      return
    }

    await remember($, parsePlanUsage(res.text), undefined)
  } catch {
    // Netzwerk- oder Parse-Fehler: letzten Stand behalten, später erneut versuchen.
  } finally {
    isFetching = false
  }
}

const toggleFable = async ($: EngineInterface) => {
  const isShown = await update($, showFable, value => !value)
  await $.store.set('showFable', isShown)

  return isShown
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    const stored = await $.store.get('showFable')
    await update($, showFable, () => stored !== false)

    if (usage.rateLimits.length > 0) {
      await remember($, fromSession(usage.rateLimits), usage.cost?.usd)
    } else {
      const last = await $.store.get('last')
      const at = await $.clock.now()
      const start: Snapshot = isSnapshot(last) ? { ...last, isLive: false } : { limits: [], at, isLive: true }
      await update($, snapshot, () => withCost(start, usage.cost?.usd))
    }

    await $.command.register({
      name: 'usage-bar',
      description: 'Usage-Leiste: "/usage-bar fable" blendet das Fable-Limit ein oder aus',
      argumentHint: 'fable',
    })

    // Die "↻ …"-Angaben jede Minute neu zeichnen.
    $.clock.every(MINUTE, () => $.ui.invalidate('ui.render'))
    void refreshPlan($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await remember($, fromSession(e.rateLimits), e.cost?.usd)
    void refreshPlan($)

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async ($, e) => {
    if (e.args.trim().toLowerCase() !== 'fable') {
      return { text: 'Usage-Leiste: "/usage-bar fable" blendet das Fable-Limit ein oder aus.' }
    }

    const isShown = await toggleFable($)

    return { text: `Fable-Limit ${isShown ? 'eingeblendet' : 'ausgeblendet'}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)

    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const now = await $.clock.now()
    const isFableShown = await read($, showFable)
    const limits = snap.limits
      .filter(limit => limit.kind !== 'fable' || isFableShown)
      .sort((a, b) => rank(a.kind) - rank(b.kind))

    const fableToggle = (
      <Button
        key="toggle-fable"
        plain
        dimColor
        label={isFableShown ? '● Fable' : '○ Fable'}
        onPress={() => toggleFable($)}
      />
    )

    if (limits.length === 0) {
      const cost = snap.costUsd === undefined ? '' : ` · Session $${snap.costUsd.toFixed(2)}`

      return (
        <Box key="usage-bar" flexDirection="row" columnGap={3}>
          <Text dimColor>{`Usage: noch keine Limit-Daten (kommen mit der ersten Antwort)${cost}`}</Text>
        </Box>
      )
    }

    const segmentColumns = Math.floor((e.props.bodyColumns - 10) / Math.max(1, limits.length))
    const barCells = clamp(segmentColumns - 22, 6, 16)
    const barPixels = clamp(barCells * 8, 60, 120)

    const segments = limits.map(limit => {
      const percent = percentOf(limit, now)
      const color = colorFor(percent)
      const label = LABELS[limit.kind] ?? limit.kind
      const reset = resetText(limit, now)
      const shown = `${Math.round(percent)}%`
      const filled = Math.round((clamp(percent, 0, 100) / 100) * barCells)

      return (
        <Box key={limit.kind} flexDirection="row" alignItems="center" gap={1}>
          <Text bold>{label}</Text>
          {Svg ? (
            <Svg
              source={svgBar(percent, HEX[color], barPixels)}
              alt={`${label}: ${shown} verbraucht`}
              width={barPixels}
              height={BAR_HEIGHT}
            />
          ) : (
            <Box flexDirection="row">
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'━'.repeat(barCells - filled)}</Text>
            </Box>
          )}
          <Text bold color={color}>{shown}</Text>
          {reset ? <Text dimColor>{reset}</Text> : null}
        </Box>
      )
    })

    const hasFable = snap.limits.some(limit => limit.kind === 'fable')

    return (
      <Box key="usage-bar" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3}>
        {segments}
        {isFableShown && !hasFable ? <Text dimColor>Fable: keine Daten</Text> : null}
        {snap.isLive ? null : <Text dimColor>{`(Stand vor ${formatDuration(now - snap.at)})`}</Text>}
        {fableToggle}
      </Box>
    )
  })
}
