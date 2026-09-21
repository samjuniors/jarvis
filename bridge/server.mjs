/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { createBrain } from './brain.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, extname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { renderPage } from './page.mjs'
import ZAI from 'z-ai-web-dev-sdk'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * A minimal .env reader, so the one file a person can inspect (.env.local in
 * the repo root) is also the one file this server actually reads. Nothing is
 * overridden: a variable already set in the shell wins over the file, so
 * `JARVIS_BRIDGE_PORT=9000 npm run bridge` still works.
 *
 * Values are simple KEY=VALUE lines; quotes around the value are stripped and
 * blank/comment lines are skipped. See .env.local for what is recognised.
 */
function loadEnvFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return // absent is the normal case
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value === '') continue // a blank entry means "use the default"
    if (!(m[1] in process.env)) process.env[m[1]] = value
  }
}
loadEnvFile(join(REPO_ROOT, '.env.local'))
loadEnvFile(join(REPO_ROOT, '.env'))

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

/**
 * The sandbox's public preview rides the platform's edge proxy, which rewrites
 * Host to an internal hostname before the request ever reaches the bridge
 * (the preview name survives only in an `abc` header). The same-host test
 * therefore can never succeed there, even though the page is the app's own
 * face — so preview origins on the platform's domain are allowed outright.
 * Set JARVIS_ALLOWED_ORIGINS for anything else that isn't same-host.
 */
const PREVIEW_SUFFIX = '.space-z.ai'

/**
 * The bridge serves the app's own frontend now, so the primary case is the
 * same-origin one: a page it served connecting back to it. Any request whose
 * Origin matches the Host it was addressed to is allowed outright — the page
 * is ours, and this is exactly what the original allowlist existed to say yes
 * to when "ours" meant a Vite dev server on a local port.
 */
function originAllowed(origin, host) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // Caddy's `header_up Host {host}` forwards the name without its port, while
  // the Origin always carries one (or :80/:443 implied), so the comparison is
  // on hostnames: same host is the same site, which is the whole question.
  const requestHost = String(host ?? '')
    .toLowerCase()
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '')
  if (requestHost && url.hostname.toLowerCase() === requestHost) return true
  // The platform preview: the edge rewrites Host (see PREVIEW_SUFFIX above),
  // so the preview domain — the app's own face in the sandbox product — is
  // recognised by its suffix instead of by the address it arrived on.
  const hostname = url.hostname.toLowerCase()
  if (
    hostname.endsWith(PREVIEW_SUFFIX) &&
    hostname.length > PREVIEW_SUFFIX.length
  ) {
    return true
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * The orchestrator model now lives in brain.mjs — the z-ai backend picks it.
 */

/**
 * Tool gating lives in brain.mjs now: every tool this bridge
 * offers is read-only or generative, so there is nothing left to gate.
 */

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Neural voices, generated through the z-ai SDK that already powers the brain.
 *
 * These are the fallback — and in this sandbox, the default — speech engine for
 * /tts: far warmer than any browser's speechSynthesis, no key to own, and a
 * handful of female conversational voices for the SOFIA persona (plus two male
 * ones, so the JARVIS persona has somewhere to go). If an ElevenLabs key IS
 * configured, it wins instead — see the /tts handler.
 *
 * Genders were measured, not guessed: samples of each voice were generated and
 * their fundamental frequency analysed (female ≈ 165–255 Hz, male ≈ 85–155 Hz).
 */
const ZAI_VOICES = [
  { id: 'tongtong', label: 'Tongtong', gender: 'female', vibe: 'warm · friendly' },
  { id: 'chuichui', label: 'Chuichui', gender: 'female', vibe: 'lively · playful' },
  { id: 'kazi', label: 'Kazi', gender: 'female', vibe: 'crisp · clear' },
  { id: 'douji', label: 'Douji', gender: 'female', vibe: 'smooth · natural' },
  { id: 'luodo', label: 'Luodo', gender: 'female', vibe: 'expressive · warm' },
  { id: 'jam', label: 'Jam', gender: 'male', vibe: 'british · calm' },
  { id: 'xiaochen', label: 'Xiaochen', gender: 'male', vibe: 'steady · professional' },
]
const ZAI_VOICE_IDS = new Set(ZAI_VOICES.map((v) => v.id))
const DEFAULT_ZAI_VOICE = 'tongtong'

/** One client for every sentence — creating an SDK instance per request was
 *  pure latency. Latched "broken" only if creation itself fails, so a key that
 *  exists but misbehaves still falls back per-sentence in the browser. */
let zaiTtsClient = null
async function zaiTTS() {
  if (!zaiTtsClient) zaiTtsClient = await ZAI.create()
  return zaiTtsClient
}

/** The SDK takes at most 1024 characters a call. Spoken sentences are far
 *  shorter, but a long filler or a chunked answer can exceed it — split at
 *  sentence boundaries and keep anything tail-heavy as its own chunk. */
function chunkForTts(text, max = 1000) {
  if (text.length <= max) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (current && (current + sentence).length > max) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/** The same filler lines are spoken over and over ("Working on it, sir") —
 *  caching them makes the second occurrence instant. Small map, capped by
 *  count; a sentence of wav is a few hundred KB. */
const TTS_CACHE_MAX = 96
const ttsCache = new Map()

/**
 * Merge the PCM of several WAV buffers into one file. This backend only
 * speaks wav — mp3 is refused with code 1214 — and naive concatenation would
 * bury RIFF headers mid-stream. Every chunk comes from the same engine, so
 * the first buffer's fmt block describes them all.
 */
function mergeWav(buffers) {
  const first = buffers[0]
  // "RIFF" (8) + "WAVE" (4) + "fmt " id/size (8) + the fmt payload itself.
  // The engine also writes an "AIGC" metadata chunk between fmt and data —
  // the data scan below walks past whatever chunks it finds.
  const fmtEnd = 20 + first.readUInt32LE(16)
  const fmt = first.subarray(0, fmtEnd)
  const datas = buffers.map((b) => {
    let off = fmtEnd
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4)
      const size = b.readUInt32LE(off + 4)
      if (id === 'data') return b.subarray(off + 8, off + 8 + size)
      off += 8 + size + (size % 2)
    }
    return b.subarray(0, 0)
  })
  const total = datas.reduce((n, d) => n + d.length, 0)
  const out = Buffer.alloc(fmtEnd + 8 + total)
  fmt.copy(out, 0, 0, fmtEnd)
  let o = fmtEnd
  out.write('data', o, 'ascii')
  o += 4
  out.writeUInt32LE(total, o)
  o += 4
  for (const d of datas) {
    d.copy(out, o)
    o += d.length
  }
  out.writeUInt32LE(o - 8, 4) // the RIFF size the copied header still carried
  return out
}

/**
 * Generate one utterance as wav through the neural engine. Returns a Buffer,
 * or throws — the caller turns that into a 503 and the browser falls back to
 * its own system voice for that sentence.
 *
 * The backend rate-limits under bursts (429) — a long answer cut into
 * sentences can be three calls in as many seconds — so each chunk is retried
 * with a short backoff before anything is declared failed.
 */
async function synthesizeNeural(text, voiceId, speed) {
  const zai = await zaiTTS()
  const chunks = chunkForTts(text)
  const parts = []
  for (const chunk of chunks) {
    parts.push(await withRetry(() => speakChunk(zai, chunk, voiceId, speed)))
  }
  return parts.length === 1 ? parts[0] : mergeWav(parts)
}

/** One SDK call, one buffer. */
async function speakChunk(zai, input, voice, speed) {
  const response = await zai.audio.tts.create({
    input,
    voice,
    speed,
    response_format: 'wav',
    stream: false,
  })
  return Buffer.from(new Uint8Array(await response.arrayBuffer()))
}

/** Retry a call on 429 only, with a growing pause. Anything else — auth,
 *  bad request — will fail identically next time and is not worth waiting on.
 *  The pause ladder is deliberately generous: a burst of sentences can trip
 *  a per-minute window, and the alternative to waiting is the browser falling
 *  back to its robot voice for that sentence. */
async function withRetry(fn, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = String(err?.message ?? err)
      if (!/429|too many/i.test(msg)) throw err
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin, req.headers.host)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Three tiers, best first: an ElevenLabs key (best English voices, needs a
    // key the user supplies), then the z-ai neural engine (no key, conversational
    // female/male voices — what this sandbox runs on), then the browser's own
    // speech. STT only upgrades with an ElevenLabs key (Scribe); the browser's
    // own recogniser covers everyone else.
    const eleven = Boolean(elevenKey())
    const engine = eleven ? 'elevenlabs' : 'zai'
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: true,
        stt: eleven,
        engine,
        voices: ZAI_VOICES,
      }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text, voice, speed
    try {
      ;({ text, voice, speed } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }

    // ---- tier 1: ElevenLabs, when the user has put a key in .env.local -----
    // (or their Claude Code MCP config). Best English voices there are; when
    // it is absent we never even dial them.
    const key = elevenKey()
    if (key) {
      try {
        const upstream = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
            // 22kHz mono is half the bytes of 44kHz and indistinguishable through
            // a laptop speaker; optimize_streaming_latency=3 trades a little
            // prosody for a much earlier first byte.
            `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              // Flash is the low-latency model — a conversation needs speed more
              // than it needs the last few percent of quality.
              model_id: 'eleven_flash_v2_5',
              voice_settings: {
                stability: 0.4,
                similarity_boost: 0.75,
                speed: 1.05,
              },
            }),
          },
        )
        if (!upstream.ok) {
          res.writeHead(upstream.status, cors)
          return res.end(await upstream.text())
        }

        // Pipe it through rather than buffering. Waiting for the whole file here
        // would throw away everything the streaming endpoint just bought us.
        res.writeHead(200, {
          ...cors,
          'content-type': 'audio/mpeg',
          'cache-control': 'no-cache',
        })
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
        return res.end()
      } catch (err) {
        res.writeHead(502, cors)
        return res.end(String(err?.message ?? err))
      }
    }

    // ---- tier 2: the z-ai neural engine (no key, this sandbox's default) -----
    // The same SDK that powers the brain, generating speech a class above the
    // browser's speechSynthesis. The browser sends its chosen voice id; anything
    // unrecognised falls back to the default female rather than being refused,
    // because a saved choice from a newer bridge should not brick an older one.
    const voiceId = ZAI_VOICE_IDS.has(voice) ? voice : DEFAULT_ZAI_VOICE
    const clamped = Math.min(2, Math.max(0.5, Number(speed) || 1))
    const cacheKey = `${voiceId}|${clamped}|${text}`
    try {
      let audio = ttsCache.get(cacheKey)
      if (!audio) {
        audio = await synthesizeNeural(text, voiceId, clamped)
        ttsCache.set(cacheKey, audio)
        if (ttsCache.size > TTS_CACHE_MAX) {
          // Map preserves insertion order, so the first key is the oldest.
          ttsCache.delete(ttsCache.keys().next().value)
        }
      }
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/wav',
        'cache-control': 'no-cache',
        'x-tts-engine': 'zai',
        'x-tts-voice': voiceId,
      })
      return res.end(audio)
    } catch (err) {
      // 503, not 500: the browser's per-sentence fallback treats any failure
      // here as "cloud is gone, use the system voice" — which is exactly right.
      console.error('[jarvis] neural tts failed:', err?.message ?? err)
      res.writeHead(503, cors)
      return res.end(String(err?.message ?? 'neural tts failed'))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // ---------------------------------------------------------------------
  // The face. Everything else above is the bridge's own API; anything left
  // that is a GET (or HEAD) is served as a file from the built frontend, so
  // the one process can be the whole app: page, assets, websocket, proxies.
  // ---------------------------------------------------------------------
  if (req.method === 'GET' || req.method === 'HEAD') {
    const served = await serveStatic(req, res, cors)
    if (served) return
  }

  res.writeHead(404, cors)
  res.end()
}

/**
 * Where the built frontend lives. `vite build` drops it in dist/ next to the
 * bridge; JARVIS_DIST overrides for serving from elsewhere.
 */
const DIST = process.env.JARVIS_DIST ?? join(homedir(), 'jarvis', 'dist')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serve one file out of DIST. Returns false when the path is not a file we
 * can serve, so the caller can fall through to 404. Traversal is refused
 * before it ever touches the disk, and only whitelisted extensions are
 * content-typed — anything else would be handed over as a download.
 */
async function serveStatic(req, res, cors) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    return false
  }
  if (pathname.includes('\0')) return false

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (!rel || rel.includes('..')) return false

  let file = resolvePath(DIST, rel)
  if (!file.startsWith(DIST)) return false

  try {
    let st = await stat(file)
    if (st.isDirectory()) {
      file = join(file, 'index.html')
      st = await stat(file)
    }
    if (!st.isFile()) return false

    const type = MIME_TYPES[extname(file)]
    if (!type) return false

    // Hashed build assets are immutable; the entry document must always be
    // revalidated or every deploy shows the previous build's shell.
    const immutable = pathname.startsWith('/assets/')
    res.writeHead(200, {
      ...cors,
      'content-type': type,
      'content-length': st.size,
      'cache-control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }

    const data = await readFile(file)
    res.end(data)
    return true
  } catch {
    return false
  }
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin, req.headers.host)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[jarvis] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log('[jarvis] brain: z-ai-web-dev-sdk · 14 tools')
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Announcing a tool on the HUD, once, and only when it actually runs.
   *
   * The brain announces a call just before executing it and settles it when
   * the result lands, so the badge never lights up for work that never
   * happened.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on the interrupt call alone is not enough. It resolves when the
   * brain has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The brain emits exactly one terminal event per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "display" in the tool badge and trigger a
    // "working on it" filler for something already on screen.
    if (name === 'display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done
    // for the user, and the badge would be describing the very thing they
    // can see.
    if (name.startsWith('ui_')) return
    sendTurn({ type: 'tool', name })
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  /**
   * The brain. One per connection, exactly like the agent it replaces: it
   * owns the conversation with the model, streams spoken text back a delta
   * at a time, and pushes blades and ui ops down this same socket as the
   * tools fire. Turn boundaries — including when a barge-in has actually
   * stopped the turn — come back through finishTurn.
   */
  const brain = createBrain({
    send,
    sendTurn,
    // A turn is starting for client question `id`; every frame it emits
    // until it finishes is tagged with that id, so the tail of an
    // abandoned answer can be ignored by whoever is listening now.
    begin: (id) => {
      answering = id
    },
    announce: announceTool,
    settle: settleTool,
    finishTurn: () => {
      finishTurn?.()
      finishTurn = null
      // One turn's tool ids are never referred to again, and these
      // otherwise grow for as long as the socket is open.
      seenTools.clear()
      heldTools.clear()
    },
  })

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then
       * the new question — and stopping a turn is asynchronous. Handing
       * the question to the brain before the previous turn has wound down
       * means its last tokens can be emitted after the new one has begun
       * and land on the new turn's listener.
       *
       * Waiting costs nothing when nothing is interrupting — the chain is
       * an already-resolved promise — and removes the cross-talk when
       * there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      // The character the browser is currently wearing — the brain swaps its
      // system prompt when it changes. Anything unknown is ignored and the
      // brain keeps the persona it already had.
      const persona = typeof msg.persona === 'string' ? msg.persona : null
      void settling.then(() => {
        brain.ask(text, id, persona)
      })
    }

    if (msg.type === 'interrupt') {
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(brain.interrupt())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    brain.close()
  })
})
