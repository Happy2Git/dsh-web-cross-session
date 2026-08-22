/**
 * dsh-web-cross-session — second-level session picker.
 *
 * Headless store + thin React overlay. The store is a module singleton (one
 * picker at a time) and the overlay renders into the conversation.input.overlay
 * slot, subscribing to the store and rendering null while closed — the same
 * pattern as the slash menu's MenuView.
 *
 * Two modes share the shell:
 *  - reference: opened from the '@' source when a picked main session has
 *    subagent children; picking a row inserts a reference through the scoped
 *    input event (`slash/input-insert-reference`) at the original '@' span.
 *  - send: opened from the '/xsend ' claim; picking a target forwards the
 *    pending text through the host /xssn/send route and reports the outcome.
 *
 * @module dsh-web-cross-session/picker
 */

import { useEffect, useSyncExternalStore, type CSSProperties } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Menu group label for the session source (unique among '@' sources). */
export const TRIGGER_NAME = 'sessions'

export const SESSION_REFERENCE_SCHEME = 'dsh-session'

/** One reference's full binding, encoded into the ref itself: the composer that picked it, the target, and the display label captured at pick time. The codec's serialize() receives only the ref — no session projection — so the binding must ride the ref to survive multi-session, multi-composer use without shared mutable state. */
export interface SessionReferencePayload {
  /** The session whose composer inserted the chip (serialization identity). */
  readonly f: string
  /** The referenced target session. */
  readonly t: string
  /** Display label captured at pick time; absent falls back to the target id. */
  readonly l?: string
}

/** UTF-8-safe base64url: labels are user text, so the byte path is mandatory. */
function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Lossless session-reference URI carrying its own binding, mirroring the core
 * package's scheme: dsh-session:<base64url(JSON)>. Kept local because the
 * client bundle must not value-import core packages; the scheme, the JSON
 * encoding, and the base64url alphabet are the contract.
 */
export function encodeSessionReferenceUri(payload: SessionReferencePayload): string {
  return `${SESSION_REFERENCE_SCHEME}:${toBase64Url(JSON.stringify(payload))}`
}

/** Decode one reference URI; undefined when it is not this plugin's format. */
export function decodeSessionReferenceUri(uri: string): SessionReferencePayload | undefined {
  if (!uri.startsWith(`${SESSION_REFERENCE_SCHEME}:`)) return undefined
  try {
    const payload = JSON.parse(fromBase64Url(uri.slice(SESSION_REFERENCE_SCHEME.length + 1))) as Partial<SessionReferencePayload>
    if (typeof payload.f !== 'string' || typeof payload.t !== 'string') return undefined
    return {
      f: payload.f,
      t: payload.t,
      ...(typeof payload.l === 'string' && payload.l !== '' ? { l: payload.l } : {}),
    }
  } catch {
    return undefined
  }
}

/** One picker row. */
export interface PickerOption {
  readonly id: string
  readonly label: string
  /** True when the row is a subagent session (shown under its parent). */
  readonly subagent: boolean
  /** The parent's label, for the no-repeated-title fallback. */
  readonly parentLabel?: string
}

export type PickerMode = 'reference' | 'send'

export interface PickerState {
  readonly open: boolean
  readonly mode: PickerMode
  readonly title: string
  readonly options: readonly PickerOption[]
  /** send mode: the text being forwarded. */
  readonly pendingText: string
  readonly status: 'idle' | 'sending' | 'done' | 'error'
  readonly statusText: string
}

const CLOSED: PickerState = {
  open: false,
  mode: 'reference',
  title: '',
  options: [],
  pendingText: '',
  status: 'idle',
  statusText: '',
}

let state: PickerState = CLOSED
const listeners = new Set<() => void>()

/** The current picker state (render source of truth). */
export function getPickerState(): PickerState {
  return state
}

/** Subscribe to picker state changes; returns the unsubscribe disposer. */
export function subscribePicker(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function setState(next: PickerState): void {
  state = next
  for (const listener of listeners) listener()
}

/** One open picker's bindings, held outside the render state. Each open mints a fresh token so a settled response from a superseded open can never write over newer state. */
interface PickerBinding {
  readonly actx: ClientContext
  /** Monotonic open-generation; stale resolutions compare and bail. */
  readonly token: number
  /** reference mode: the original '@' token span for the insert event. */
  readonly span?: TokenSpan
  /** reference mode: the picked row becomes the inserted reference. */
  readonly onPick?: (option: PickerOption) => void
  /** send mode: performs the /xssn/send call; receives the binding's abort signal. */
  readonly send?: (option: PickerOption, signal: AbortSignal) => Promise<void>
  /** send mode: aborted when the picker closes before settlement. */
  readonly controller?: AbortController
}

let binding: PickerBinding | null = null
let nextToken = 0

/** Open the picker in reference mode (main session + its subagent children). fromSessionId is the composer that opened it — every inserted reference binds to it. */
export function openReferencePicker(
  actx: ClientContext,
  span: TokenSpan,
  main: { readonly id: string; readonly label: string },
  children: readonly { readonly id: string; readonly label: string }[],
  fromSessionId: string,
): void {
  const options: PickerOption[] = [
    { id: main.id, label: main.label, subagent: false },
    ...children.map(child => ({
      id: child.id,
      label: child.label,
      subagent: true,
      parentLabel: main.label,
    })),
  ]
  const token = ++nextToken
  binding = {
    actx,
    token,
    span,
    onPick: (option) => {
      const payload: SessionReferencePayload = { f: fromSessionId, t: option.id, l: option.label }
      const uri = encodeSessionReferenceUri(payload)
      const reference: ReferenceInsert = {
        source: TRIGGER_NAME,
        ref: uri,
        label: option.label,
        clipboardText: `@[${option.label}](${uri})`,
      }
      actx.bail(actx, 'slash/input-insert-reference', { reference, span })
      setState(CLOSED)
    },
  }
  setState({
    open: true,
    mode: 'reference',
    title: main.label,
    options,
    pendingText: '',
    status: 'idle',
    statusText: '',
  })
}

/** Open the picker in send mode (forward pendingText to the picked target). */
export function openSendPicker(
  actx: ClientContext,
  pendingText: string,
  options: readonly PickerOption[],
  send: (option: PickerOption, signal: AbortSignal) => Promise<void>,
): void {
  const token = ++nextToken
  binding = {
    actx,
    token,
    controller: new AbortController(),
    send,
  }
  setState({
    open: true,
    mode: 'send',
    title: '转发消息到会话',
    options,
    pendingText,
    status: 'idle',
    statusText: '',
  })
}

/** Settle the currently highlighted row (or the only flow the mode defines). */
export async function pickOption(option: PickerOption): Promise<void> {
  const current = binding
  if (current === null || !state.open) return
  if (current.onPick !== undefined) {
    current.onPick(option)
    return
  }
  if (current.send !== undefined && current.controller !== undefined) {
    const { signal, } = current.controller
    setState({ ...state, status: 'sending', statusText: `正在转发到 ${option.label} …` })
    try {
      await current.send(option, signal)
      // A close/reopen since this click started supersedes this settlement.
      if (binding !== current) return
      setState({ ...state, status: 'done', statusText: `已转发到 ${option.label}` })
    } catch (error: unknown) {
      if (binding !== current) return
      const cancelled = error instanceof DOMException && error.name === 'AbortError'
      setState({
        ...state,
        status: 'error',
        statusText: cancelled
          ? '已取消'
          : error instanceof Error ? error.message : String(error),
      })
    }
    return
  }
}

/** Dismiss the picker (Escape / close button); an in-flight forward is aborted. */
export function closePicker(): void {
  binding?.controller?.abort(new Error('picker closed'))
  binding = null
  setState(CLOSED)
}

/** Test-only reset of the module singleton. */
export function resetPickerForTests(): void {
  binding?.controller?.abort()
  binding = null
  setState(CLOSED)
}

/** Display label for one row: subagent rows never repeat their parent's title. */
export function displayLabel(option: PickerOption): string {
  if (option.subagent && option.label === option.parentLabel) {
    return `[subagent] ${option.id.slice(0, 9)}`
  }
  return option.label
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  right: 0,
  zIndex: 40,
  background: '#1e1f24',
  border: '1px solid #3a3d46',
  borderRadius: 8,
  padding: 8,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
  maxHeight: 280,
  overflowY: 'auto',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
}

const titleStyle: CSSProperties = {
  color: '#9aa0ab',
  marginBottom: 6,
  padding: '0 4px',
}

const rowStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: 6,
  border: 0,
  background: 'transparent',
  color: '#e8eaed',
  cursor: 'pointer',
}

const subStyle: CSSProperties = {
  display: 'block',
  padding: '3px 8px 3px 22px',
}

const statusStyle: CSSProperties = {
  color: '#9aa0ab',
  margin: '4px 4px 0',
}

/** The overlay component: renders null while closed, else the option list. */
export function PickerOverlay(): JSX.Element | null {
  const snapshot = useSyncExternalStore(subscribePicker, getPickerState)
  useEffect(() => {
    if (!snapshot.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePicker()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [snapshot.open])
  if (!snapshot.open) return null
  return (
    <div style={overlayStyle}>
      <div style={titleStyle}>{snapshot.title}</div>
      {snapshot.options.map(option => (
        <button
          key={option.id}
          type="button"
          style={option.subagent ? { ...rowStyle, ...subStyle } : rowStyle}
          onClick={() => { void pickOption(option) }}
        >
          {displayLabel(option)}
        </button>
      ))}
      {snapshot.statusText !== '' && <div style={statusStyle}>{snapshot.statusText}</div>}
    </div>
  )
}
