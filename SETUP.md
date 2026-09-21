# Running SOFIA locally — and never going dark

The assistant is a conversation, and a conversation dies the moment one
sentence goes unanswered. Every external service it depends on — the model
that thinks, the transcriber that hears, the voice that speaks — has a moment
where it rate-limits, times out, or simply goes down. So none of them is
load-bearing alone: each is one link in a **chain**, and the chain is walked
on failure, automatically, mid-turn.

```
BRAIN   z-ai (built-in)  →  Gemini  →  any local server (Ollama, LM Studio…)
EAR     Deepgram  →  ElevenLabs Scribe  →  z-ai ASR (no key)  →  local  →  the browser's own recogniser
VOICE   ElevenLabs  →  z-ai neural (no key)  →  local  →  the browser's own voice
```

How the failover behaves:

- **Brain** — if the active engine fails a turn, the next link answers *that
  same turn*. Two failures in a row bench the link for 90 seconds (it is
  retried after). The HUD rail shows `BRAIN · <engine>` and marks `FALLBACK`
  the moment a backup takes over; the settings panel (gear → ENGINES) shows
  every link and its state.
- **Ear** — each spoken phrase is transcribed by the first link that answers.
  Three failures in a row bench a link for 60 seconds. If the whole chain is
  down, the app switches to the browser's own speech recognition mid-session.
- **Voice** — each sentence falls through on its own; the browser's
  `speechSynthesis` is the last resort, sentence by sentence.

---

## 1 · Quick start (no keys at all)

```bash
git clone https://github.com/samjuniors/sofianew.git
cd sofianew
npm install
npm run build            # vite build → dist/
node bridge/server.mjs   # serves the app + the bridge on :8787
```

Open **http://localhost:8787**. That's the whole app — the page, the
WebSocket, the speech endpoints, one process, one port.

In this sandbox the z-ai engine (brain + voices + transcription) is
pre-authenticated, so this "no keys" mode is fully live. **On your own
machine the z-ai links are not authenticated** — the brain chain will fall
through to whatever you configure below. Set at least one of **Gemini** or a
**local model** or the assistant cannot think.

Configuration lives in **`.env.local`** (never committed; `.env.sample` is
the documented template). The bridge reads it at startup — after editing,
restart the process.

## 2 · The brain — Gemini (one key, free tier)

Get a key at **https://aistudio.google.dev/apikey** and put it in
`.env.local`:

```ini
GEMINI_API_KEY=AIza...
# optional, defaults to gemini-2.0-flash
GEMINI_MODEL=gemini-2.0-flash
```

That's it. The key lives in the bridge (`.env.local`), never in the browser.
When the primary engine fails, Gemini answers through Google's
OpenAI-compatible endpoint — same wire format, same tools, same streaming,
so nothing else changes.

## 3 · The brain — a local model (nothing leaves the machine)

Any OpenAI-compatible chat server works. The common ones:

**Ollama** (easiest):

```bash
# install from https://ollama.com, then:
ollama pull llama3.1        # or qwen2.5, mistral, …
ollama serve               # usually already running, on :11434
```

```ini
LOCAL_LLM_BASE_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3.1
```

The `/v1` is appended for you. If `OLLAMA_BASE_URL` is set in your shell
it is picked up automatically.

**LM Studio** — start the local server (default `:1234`), then:

```ini
LOCAL_LLM_BASE_URL=http://localhost:1234/v1
LOCAL_LLM_MODEL=<the model id you loaded>
```

**vLLM / llama.cpp / text-generation-webui** — same pattern: wherever they
expose `/v1/chat/completions`.

Notes:

- Small local models may refuse the tool schema. The chain detects that,
  retries once without tools, and remembers — you get plain answers instead
  of a failed turn.
- Tools that need the primary engine (live web search, image generation)
  degrade with it; the model is told and answers from what it has.
- A pin (`JARVIS_LLM_PROVIDER=local`) collapses the chain to one link on
  purpose — for benchmarking, or because you want only local.

## 4 · The ear — Deepgram / ElevenLabs / local Whisper

```ini
# Deepgram (fastest, cheapest; free credit at console.deepgram.com)
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3            # optional

# or ElevenLabs Scribe (same key as the voices)
ELEVENLABS_API_KEY=...

# or a local transcription server (OpenAI /v1/audio/transcriptions shape)
LOCAL_STT_URL=http://localhost:8000
LOCAL_STT_MODEL=whisper-1
```

Local options for the last one:

```bash
# speaches / faster-whisper-server (docker)
docker run -p 8000:8000 ghcr.io/speaches-ai/speaches:latest \
  --model small --language en

# or LocalAI, which also covers voice below
```

Without any key, the z-ai transcriber serves (where authenticated) and the
browser's own recognition is the last link — the app is never deaf.

## 5 · The voice — ElevenLabs / a local speech server

```ini
# ElevenLabs (best English voices; key from elevenlabs.io)
ELEVENLABS_API_KEY=...
JARVIS_VOICE_ID=JBFqnCBsd6RMkjZzb   # optional, pick per key

# or a local OpenAI-compatible /v1/audio/speech server
LOCAL_TTS_URL=http://localhost:8880
LOCAL_TTS_MODEL=kokoro
LOCAL_TTS_VOICE=af_sky
```

Local options:

```bash
# kokoro-fastapi (82M params, runs on CPU, sounds like a person)
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu

# or openedai-speech / LocalAI — same shape
```

The 7 built-in neural voices (5 female, 2 male) need no key and no server —
pick them in the app's settings gear.

## 6 · Verifying your setup

- **`curl localhost:8787/health`** — one JSON answer: the chains, which links
  are configured, which engine is active, the voice catalogue.
- **In the app** — the settings gear → ENGINES: three chain groups, each row
  LIVE / READY / COOLING / ERROR / OFF, with the exact env var that turns a
  missing link on.
- **The HUD rail** — `BRAIN · Z-AI` normally; `BRAIN · LOCAL — FALLBACK`
  (warm amber) the moment a backup is answering.
- Kill a provider mid-conversation and watch the next one take over the same
  turn.

## 7 · Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "every reasoning engine is unreachable" | no brain link is configured/alive | set `GEMINI_API_KEY` or a `LOCAL_LLM_*` server |
| answers are suddenly plain (no tools) | local model refused the tool schema | expected — use a bigger model or Gemini for tool turns |
| `BRAIN · FALLBACK` never clears | the primary is still benched | it self-heals after ~90s, or restart the bridge |
| mic works, nothing transcribes | every ear link down | check `x-stt-engine` on `/stt` responses; the browser recogniser takes over after 4 failures |
| voice sounds robotic | fell to the system voice | every cloud/local voice failed — check ENGINES |
| `curl /health` says a link is OFF | key not read | `.env.local` is read at startup only — restart the bridge |

Everything about the chains lives in one file — `bridge/providers.mjs` —
and one panel in the app. Read either; they explain themselves.
