/**
 * dsh-plugin-dictation — HOST half.
 *
 * WHY THIS EXISTS
 *   The browser's own SpeechRecognition ships audio to Google and fails with a
 *   `network` error inside the Electron shell (no Google API key). So the page
 *   records audio, POSTs it to the route below, and Whisper transcribes it ON
 *   THIS MACHINE. Nothing leaves your computer and no API key is involved.
 *
 * ENGINE
 *   faster-whisper in its own venv (~/.dsh/dictation-venv), driven through
 *   worker.py: ONE long-lived child that keeps the model loaded. Spawning
 *   `python -m whisper` per request pays the model load every time (~6 s for a
 *   3 s clip on an M-series CPU); dictation wants the phrase back in about a
 *   second. The worker starts on the first dictation, not at boot, and dies
 *   with the harness (stdin closes) or when this plugin is disposed.
 *
 *   The interpreter is addressed by absolute path (the dedicated venv, or
 *   DSH_DICTATION_PYTHON), never whatever `python` happens to be on PATH.
 *
 * ROUTE
 *   POST /api/dictation/transcribe  { audio: <base64>, mime?: string, model?: string }
 *     -> { ok: true, text, model, seconds }
 *     -> { ok: false, error }
 *   Same-origin, like the preview plugin's bridge, so no CORS and no token.
 *
 * SECURITY NOTE
 *   The upload is written to a temp file and only its PATH is handed to the
 *   worker as JSON; no user-supplied text reaches a shell.
 *
 * @module dsh-plugin-dictation
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Cordis-plugin name for loader diagnostics. */
export const name = 'dsh-plugin-dictation'

/** We need the host HTTP server to expose the transcription route. */
export const inject = ['webServer']

/** Exact path the browser half POSTs recorded audio to. */
const TRANSCRIBE_PATH = '/api/dictation/transcribe'

/** `small` is the latency/accuracy balance for dictation; pass `model` per request to override. */
const DEFAULT_MODEL = 'small'

/** Only names Whisper actually publishes; the value reaches a model loader, so do not pass arbitrary strings. */
const ALLOWED_MODELS = new Set(['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v3', 'large-v3-turbo', 'turbo'])

/** Hard ceiling on one transcription. The FIRST one also downloads/loads the model, hence generous. */
const TRANSCRIBE_TIMEOUT_MS = 180_000

/** Refuse absurd uploads before doing anything. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'worker.py')
const PYTHON = process.env.DSH_DICTATION_PYTHON
  || path.join(homedir(), '.dsh', 'dictation-venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')

/** Send JSON with no-store, matching the preview plugin's bridge. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Read a request body with a size ceiling. */
async function readBody(req, limit = MAX_AUDIO_BYTES * 2) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ── the worker ────────────────────────────────────────────────────────────────

/** @type {{ child: import('node:child_process').ChildProcess, pending: Map<string, {resolve: Function, reject: Function}>, ready: Promise<void> } | null} */
let worker = null
let nextId = 0

/** Kill the worker AND anything it started. A bare kill() leaves children behind on Windows. */
function killWorker() {
  const w = worker
  worker = null
  if (!w) return
  for (const p of w.pending.values()) p.reject(new Error('transcription worker stopped'))
  w.pending.clear()
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(w.child.pid), '/T', '/F'], { stdio: 'ignore' })
    else w.child.kill('SIGKILL')
  } catch { /* already gone */ }
}

function ensureWorker() {
  if (worker) return worker
  if (!existsSync(PYTHON)) throw new Error(`dictation engine is not installed: ${PYTHON} is missing`)

  const child = spawn(PYTHON, ['-u', WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  })
  const pending = new Map()
  let markReady
  let failReady
  const ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject })
  // Never let an unobserved rejection take the harness down.
  ready.catch(() => {})
  const me = { child, pending, ready }
  worker = me

  let stderrTail = ''
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return } // not protocol; ignore
    if (msg.ready) { markReady(); return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg)
    else p.reject(new Error(msg.error || 'transcription-failed'))
  })

  const gone = (why) => {
    const err = new Error(`${why}${stderrTail ? ': ' + stderrTail.trim().split('\n').slice(-3).join(' | ') : ''}`)
    failReady(err)
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    if (worker === me) worker = null // the next request starts a fresh one
  }
  child.on('error', (e) => gone(`transcription worker failed to start (${e.message})`))
  child.on('exit', (code) => gone(`transcription worker exited (${code})`))
  child.stdin.on('error', () => { /* worker died mid-write; 'exit' reports it */ })

  return me
}

/**
 * Transcribe one file through the worker.
 * @returns {Promise<{text: string, seconds: number, device: string}>}
 */
async function transcribeFile(audioPath, model) {
  const w = ensureWorker()
  const id = String(++nextId)
  let timer
  const result = new Promise((resolve, reject) => { w.pending.set(id, { resolve, reject }) })
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // A wedged worker is killed outright (process tree included) so it cannot
      // sit burning CPU; the next dictation starts a clean one.
      killWorker()
      reject(new Error(`transcription timed out after ${TRANSCRIBE_TIMEOUT_MS}ms`))
    }, TRANSCRIBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([w.ready, timeout])
    w.child.stdin.write(JSON.stringify({ id, audio: audioPath, model }) + '\n')
    return await Promise.race([result, timeout])
  } finally {
    clearTimeout(timer)
    w.pending.delete(id)
  }
}

/**
 * Register the transcription route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: TRANSCRIBE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })

        let dir
        try {
          const raw = await readBody(req)
          let payload
          try {
            payload = JSON.parse(raw.toString('utf8'))
          } catch {
            return json(res, 400, { ok: false, error: 'invalid-json' })
          }

          const b64 = typeof payload?.audio === 'string' ? payload.audio : ''
          if (!b64) return json(res, 400, { ok: false, error: 'no-audio' })

          // Accept a data URL or bare base64; strip the prefix if present.
          const comma = b64.indexOf(',')
          const bare = b64.startsWith('data:') && comma >= 0 ? b64.slice(comma + 1) : b64
          const bytes = Buffer.from(bare, 'base64')
          if (bytes.length === 0) return json(res, 400, { ok: false, error: 'empty-audio' })
          if (bytes.length > MAX_AUDIO_BYTES) {
            return json(res, 413, { ok: false, error: 'audio-too-large', bytes: bytes.length })
          }

          const model = typeof payload?.model === 'string' && ALLOWED_MODELS.has(payload.model)
            ? payload.model
            : DEFAULT_MODEL

          dir = await mkdtemp(path.join(tmpdir(), 'dsh-dictation-'))
          // The browser records webm/opus; the worker decodes it itself (PyAV).
          const audioPath = path.join(dir, 'clip.webm')
          await writeFile(audioPath, bytes)

          const started = Date.now()
          const out = await transcribeFile(audioPath, model)

          json(res, 200, {
            ok: true,
            text: out.text || '',
            model,
            seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
            bytes: bytes.length,
            device: out.device
          })
        } catch (e) {
          json(res, 500, { ok: false, error: e?.message || 'transcription-failed' })
        } finally {
          if (dir) { try { await rm(dir, { recursive: true, force: true }) } catch { /* temp dir, fine */ } }
        }
      }
    })
    return () => { dispose(); killWorker() }
  })
}

export default { name, inject, apply }
