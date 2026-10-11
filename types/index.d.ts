/** Ein Limit-Fenster: `five_hour`, `seven_day`, `fable` (Fable-Wochenlimit) oder ein `spend_limit`. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * Was die Leiste zeigt. `isLive` ist false, solange nur der zuletzt
 * gespeicherte Stand aus einer früheren Session vorliegt.
 */
export type Snapshot = {
  limits: Limit[]
  costUsd?: number
  at: number
  isLive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { snapshot: Snapshot | null; showFable: boolean }
  }
}
