import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import {
  PERSONAS,
  personaById,
  savePersona,
  type PersonaId,
} from '../lib/personas'
import {
  AVATARS,
  AVATAR_ORDER,
  saveAvatar,
  type AvatarId,
} from '../lib/avatars'
import {
  createSpeaker,
  currentVoiceName,
  englishVoices,
  setVoiceByName,
  neuralVoices,
  cloudVoiceId,
  setCloudVoice,
} from '../lib/tts'
import { caps } from '../lib/capabilities'

/**
 * The settings corner.
 *
 * A small gear at the top right, and behind it the three things a person can
 * reasonably want to change about an assistant they live with: the shape it
 * presents in the centre of the scene, which character it is, and which
 * voice it speaks in.
 *
 * Each of the three is a collapsible section — a tab that folds. The stack
 * used to show every list at once, which pushed the panel past the height of
 * the screen once the voice catalogue arrived; now each header carries a
 * one-word summary of the current choice, so the collapsed panel still
 * answers "what is it set to?" at a glance, and opens exactly the list you
 * came to change. One section open at a time, all closed allowed — the
 * accordion is the panel's own scrollbar discipline.
 *
 * The avatar switch is the core of the scene — the reactor dial this project
 * grew up with, or the plasma orb from the reference clip. Both read the same
 * phase colour, the same voice level, the same spin energy, so either one
 * still thinks in amber and speaks in green; only the shape differs. The
 * choice writes the store, which the scene is already subscribed to, and
 * localStorage, which is how it survives a reload.
 *
 * The persona switch is global by design — the wake word, the wordmark, the
 * boot screen, the dial word and the brain's system prompt all follow it, so
 * the machine is never half one character and half another.
 *
 * The voice list is the machine's own speechSynthesis inventory — English
 * first, best-first, and loaded lazily because Chrome populates it
 * asynchronously. Picking one auditions it immediately: hearing a voice is
 * the only way to choose one.
 */

/** The three foldable sections; null = all folded. */
type SectionId = 'avatar' | 'persona' | 'voice'

/**
 * One foldable section: header (title · current value · chevron) plus a
 * height-animated body. Height animates from 0 to auto — the one dimension
 * framer-motion can interpolate without knowing the content's height ahead
 * of time — with overflow hidden so the lists slide out of the fold instead
 * of spilling over the panel's edge mid-animation.
 */
function Section({
  id,
  title,
  value,
  open,
  onToggle,
  children,
}: {
  id: SectionId
  title: string
  value: string
  open: boolean
  onToggle: (id: SectionId) => void
  children: ReactNode
}) {
  return (
    <div className="settings-section">
      <button
        className={`settings-section-head${open ? ' on' : ''}`}
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-controls={`settings-section-${id}`}
      >
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-value" title={value}>
          {value}
        </span>
        {/* A plain chevron: rotates open rather than swapping glyphs, so the
            fold direction is legible without colour or motion. */}
        <svg
          className="settings-section-chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`settings-section-${id}`}
            className="settings-section-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="settings-section-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Settings() {
  const phase = useStore((s) => s.phase)
  const persona = useStore((s) => s.persona)
  const setPersona = useStore((s) => s.setPersona)
  const avatar = useStore((s) => s.avatar)
  const setAvatar = useStore((s) => s.setAvatar)
  const setVoice = useStore((s) => s.setVoice)
  const [open, setOpen] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  // The fold state. AVATAR leads because it is the newest and the most
  // visual choice; everything else starts folded.
  const [section, setSection] = useState<SectionId | null>('avatar')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Chrome fills the voice list some time after first paint; without this
    // listener the panel would show whatever subset existed when it opened.
    const refresh = () => setVoices(englishVoices())
    refresh()
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', refresh)
      return () => speechSynthesis.removeEventListener('voiceschanged', refresh)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (phase === 'offline' || phase === 'boot') return null

  const current = personaById(persona)

  const pickAvatar = (id: AvatarId) => {
    if (id === avatar) return
    setAvatar(id)
    saveAvatar(id)
    // The new core announces itself in the character's own voice — the swap
    // itself is silent, so the confirmation has to speak.
    const demo = createSpeaker()
    demo.say(personaById(persona).fillers.voiceSet)
    void demo.end()
  }

  const pickPersona = (id: PersonaId) => {
    if (id === persona) return
    setPersona(id)
    savePersona(id)
    // Announce the change in the new character's voice — the confirmation and
    // the audition are the same sentence.
    const demo = createSpeaker()
    demo.say(personaById(id).fillers.voiceSet)
    void demo.end()
  }

  const pickVoice = (name: string) => {
    if (setVoiceByName(name)) setVoice(name)
    const demo = createSpeaker()
    demo.say(current.fillers.voiceSet)
    void demo.end()
  }

  /** The neural picker's write-and-audition path. The choice is written
   *  before the audition speaks, so what you hear IS what you just picked —
   *  the speaker reads the id fresh from storage on every sentence. */
  const pickNeural = (id: string) => {
    if (setCloudVoice(id)) setVoice(currentVoiceName())
    const demo = createSpeaker()
    demo.say(current.fillers.voiceSet)
    void demo.end()
  }

  // Read at render time: the probe lands during boot and the panel only ever
  // opens after it, so the catalogue is already here.
  const neural = neuralVoices()
  const cloudOn = caps().tts
  const eleven = caps().engine === 'elevenlabs'

  // The one-word summaries the folded headers show. The neural label is the
  // catalogue's own (KAZI, TONGTONG…); the system picker's names carry the
  // "(Google …)" suffix nobody reads.
  const voiceSummary = currentVoiceName().replace(/\(.*?\)/g, '').trim() || 'DEFAULT'

  const toggleSection = (id: SectionId) =>
    setSection((s) => (s === id ? null : id))

  return (
    <div className="settings" ref={root}>
      <button
        className={`settings-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings — avatar, persona and voice"
        aria-expanded={open}
      >
        {/* A plain inline gear: no icon dependency, inherits the accent. */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3.2" />
          <path
            d="M12 2.8v2.4M12 18.8v2.4M4.3 4.3l1.7 1.7M18 18l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.3 19.7 6 18M18 6l1.7-1.7"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="settings-panel"
            role="dialog"
            aria-label="Assistant settings"
            initial={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <Section
              id="avatar"
              title="AVATAR"
              value={AVATARS[avatar].label}
              open={section === 'avatar'}
              onToggle={toggleSection}
            >
              <div className="settings-avatars" role="listbox" aria-label="Core shape">
                {AVATAR_ORDER.map((id) => {
                  const v = AVATARS[id]
                  const on = id === avatar
                  return (
                    <button
                      key={id}
                      role="option"
                      aria-selected={on}
                      className={`settings-avatar${on ? ' on' : ''}`}
                      onClick={() => pickAvatar(id)}
                    >
                      {/* The preview is the avatar's own SVG, injected as markup:
                          * it is authored in avatars.ts beside the label, so the
                          * card and the thing it names can never drift apart. */}
                      <span
                        className="settings-avatar-preview"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: v.preview }}
                      />
                      <span className="settings-avatar-text">
                        <span className="settings-avatar-name">{v.label}</span>
                        <span className="settings-avatar-sub">{v.sub}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </Section>

            <Section
              id="persona"
              title="PERSONA"
              value={current.mark}
              open={section === 'persona'}
              onToggle={toggleSection}
            >
              <div className="settings-personas">
                {(Object.keys(PERSONAS) as PersonaId[]).map((id) => {
                  const p = PERSONAS[id]
                  const on = id === persona
                  return (
                    <button
                      key={id}
                      className={`settings-persona${on ? ' on' : ''}`}
                      onClick={() => pickPersona(id)}
                    >
                      <span className="settings-persona-mark">{p.mark}</span>
                      <span className="settings-persona-sub">{p.sub}</span>
                      <span className="settings-persona-wake">wake: “{p.wake}”</span>
                    </button>
                  )
                })}
              </div>
            </Section>

            <Section
              id="voice"
              title="VOICE"
              value={voiceSummary}
              open={section === 'voice'}
              onToggle={toggleSection}
            >
              {cloudOn && eleven && (
                <div className="settings-empty">
                  ElevenLabs voice active — set JARVIS_VOICE_ID in .env.local to
                  change it
                </div>
              )}
              {cloudOn && !eleven && (
                <>
                  <div className="settings-voices" role="listbox" aria-label="Neural voice">
                    {neural.map((v) => {
                      const on = v.id === cloudVoiceId()
                      return (
                        <button
                          key={v.id}
                          role="option"
                          aria-selected={on}
                          className={`settings-voice${on ? ' on' : ''}`}
                          onClick={() => pickNeural(v.id)}
                        >
                          <span className="settings-voice-name">{v.label}</span>
                          <span
                            className={`settings-voice-gender${
                              v.gender === 'female' ? ' f' : ''
                            }`}
                          >
                            {v.gender === 'male' ? '♂' : '♀'}
                          </span>
                          <span className="settings-voice-lang">{v.vibe}</span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="settings-title settings-subtitle">
                    SYSTEM VOICES · FALLBACK
                  </div>
                </>
              )}
              {voices.length === 0 ? (
                <div className="settings-empty">no system voices found</div>
              ) : (
                <div className="settings-voices" role="listbox" aria-label="Voice">
                  {voices.map((v) => (
                    <button
                      key={v.name}
                      role="option"
                      aria-selected={v.name === currentVoiceName()}
                      className={`settings-voice${
                        v.name === currentVoiceName() ? ' on' : ''
                      }`}
                      onClick={() => pickVoice(v.name)}
                    >
                      <span className="settings-voice-name">
                        {v.name.replace(/\(.*?\)/g, '').trim()}
                      </span>
                      <span className="settings-voice-lang">{v.lang}</span>
                    </button>
                  ))}
                </div>
              )}
            </Section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
