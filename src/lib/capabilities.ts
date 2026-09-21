import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type NeuralVoice = {
  /** Wire id sent back to /tts, e.g. 'tongtong'. */
  id: string
  /** Human label for the HUD and the picker, e.g. 'Tongtong'. */
  label: string
  /** 'female' | 'male' — measured on the bridge, not guessed here. */
  gender: string
  /** One-line character of the voice, e.g. 'warm · friendly'. */
  vibe: string
}

export type Capabilities = {
  /** ElevenLabs speech-to-text (Scribe) is reachable via the bridge. */
  stt: boolean
  /** A cloud-quality text-to-speech engine is reachable via the bridge —
   *  ElevenLabs when a key is configured, the z-ai neural engine otherwise. */
  tts: boolean
  /** The neural voice catalogue, as reported by /health. Empty until probed
   *  (or when only the browser's own voice is available). */
  voices: NeuralVoice[]
  /** Which engine /tts will actually use: 'elevenlabs' or 'zai'. '' until
   *  probed. Determines what the voice picker offers and what the HUD names. */
  engine: '' | 'elevenlabs' | 'zai'
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false, voices: [], engine: '' }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Jarvis" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, tts: false, voices: [], engine: '' }
    probed = true
    return current
  }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as {
        stt?: boolean
        tts?: boolean
        engine?: string
        voices?: { id?: unknown; label?: unknown; gender?: unknown; vibe?: unknown }[]
      }
      // The voice list is typed at the border: anything without a string id
      // and label is dropped rather than trusted, so a bridge that grows new
      // fields cannot put junk into the picker.
      const voices = Array.isArray(h.voices)
        ? h.voices
            .filter(
              (v) =>
                typeof v?.id === 'string' &&
                typeof v?.label === 'string' &&
                v.id &&
                v.label,
            )
            .map((v) => ({
              id: String(v.id),
              label: String(v.label),
              gender: typeof v.gender === 'string' ? v.gender : '',
              vibe: typeof v.vibe === 'string' ? v.vibe : '',
            }))
        : []
      const engine =
        h.engine === 'elevenlabs' || h.engine === 'zai' ? h.engine : ''
      current = {
        stt: Boolean(h.stt),
        tts: Boolean(h.tts),
        voices,
        engine,
      }
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // boot on a health check that is only an optimisation.
  }
  probed = true
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.engine === 'elevenlabs') return 'ElevenLabs'
  if (c.engine === 'zai') return 'neural voice'
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.tts) return 'ElevenLabs voice'
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
