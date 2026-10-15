import { useCallback, useEffect, useRef, useState } from 'react'
import type { MyDeploymentRow } from '../api/types'

/** Alerts the user the moment an approval gate opens.
 *
 * Why this is not optional polish: the gate auto-rejects after ~60 seconds, and nobody sits looking
 * at the deployments table waiting for one. Making the approve button visible (which it now is)
 * only helps someone who is already on the page at that second -- so the page has to reach out.
 *
 * Fires once per (release, env, attempt). Keying on the attempt matters: a retried deployment opens
 * a genuinely NEW gate that deserves a new alert, while a row merely re-rendering must not re-alert.
 */

const STORAGE_KEY = 'magrabi.approvalAlerts.enabled'

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Short two-tone chime built with WebAudio rather than shipping an audio file -- keeps the bundle
 * self-contained and avoids a static asset that has to survive the Docker copy. */
function playChime() {
  try {
    type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext }
    const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    // Deliberately quiet and short: this can fire in an open-plan office.
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55)
    for (const [freq, at] of [
      [880, 0],
      [1320, 0.16],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(now + at)
      osc.stop(now + at + 0.3)
    }
    window.setTimeout(() => void ctx.close(), 900)
  } catch {
    // Audio is a nicety; a browser that blocks it must not break the page.
  }
}

export function useApprovalAlerts(rows: MyDeploymentRow[]) {
  const [enabled, setEnabled] = useState<boolean>(readStored)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const seen = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      /* private mode -- setting simply does not persist */
    }
  }, [enabled])

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPermission(result)
  }, [])

  useEffect(() => {
    const pending = rows.filter(
      (r) => r.status === 'pendingApproval' || r.approvalStatus === 'pending',
    )
    const keys = pending.map((r) => `${r.releaseId}:${r.env}:${r.adoAttempt ?? 1}`)

    // First pass after mount only records what is already open. Without this, loading the page
    // while three gates happen to be pending fires three notifications for things the user did not
    // just miss -- and trains them to ignore the alert.
    if (!primed.current) {
      primed.current = true
      keys.forEach((k) => seen.current.add(k))
      return
    }

    for (let i = 0; i < pending.length; i += 1) {
      const key = keys[i]
      if (seen.current.has(key)) continue
      seen.current.add(key)
      if (!enabled) continue
      const row = pending[i]
      const title = `Approval needed: ${row.pipeline ?? 'deployment'} → ${row.env ?? ''}`
      const body = row.approvalTimeoutMinutes
        ? `${row.releaseName || row.buildNumber || ''} expires in ${row.approvalTimeoutMinutes} min`
        : `${row.releaseName || row.buildNumber || ''} is waiting for approval`
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          // tag+renotify: a second gate replaces the first card rather than stacking a queue the
          // user has to dismiss one by one.
          new Notification(title, { body, tag: `approval-${key}`, renotify: true } as
            NotificationOptions & { renotify?: boolean })
        } catch {
          /* some browsers refuse constructor notifications outside a service worker */
        }
      }
      playChime()
    }

    // Keys that are no longer pending are dropped so a later gate on the same row can alert again
    // even if the attempt number is reused.
    const live = new Set(keys)
    seen.current.forEach((k) => {
      if (!live.has(k)) seen.current.delete(k)
    })
  }, [rows, enabled])

  return { enabled, setEnabled, permission, requestPermission }
}
