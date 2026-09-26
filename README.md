# DeepSeek-Harness-Dictation

> ⚠️ **Unofficial community project.** Not affiliated with or endorsed by DeepSeek. Community tooling for the [DeepSeek Harness](https://github.com/tonyd2wild) (`dsh`) agent harness.
>
> 🔒 **Privacy note:** audio never leaves your machine. The browser records it, the harness saves it to a temp file, a local Whisper model transcribes it, and the temp file is deleted. No cloud, no API key.

**Live dictation straight into the DeepSeek Harness message box**, plus a **hands-free voice mode** for talking to the agent. Click the mic and your words appear in the composer as you speak, transcribed on your own computer by [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

```
🎙️ click → talk          →   "Open the preview pane and show me the latest build."   (words appear as you say them)
🔊 tap voice mode → talk  →   a short pause sends it; talking while the agent works steers it
```

## Why not the browser's built-in speech recognition?

Chrome's `SpeechRecognition` is not on-device: it ships your audio to Google. Inside an Electron desktop shell (no Google API key) it fails with a `network` error — same page, same code, works in Chrome, dies in the app. This plugin takes Google out of the path entirely:

```
getUserMedia → MediaRecorder (webm/opus) → POST /api/dictation/transcribe → local faster-whisper → text into the composer
```

It behaves the same in a browser tab, in a desktop shell, and fully offline.

## What you get

- **Live streaming into the message box.** Words appear in the composer and grow in place while you talk; each phrase is finalised at a natural pause. Text you typed yourself is never touched.
- **Voice mode.** A ChatGPT-style round button for a hands-free conversation: talk, pause, it sends. Talk while the agent is busy and it steers the agent instead.
- **Fast.** One long-lived worker keeps the models loaded, and both are warmed when the button appears, so the first words don't wait on a model load.
- **No hallucinated "You".** Silence is filtered out (VAD) before Whisper sees it, so an empty recording returns nothing instead of Whisper's classic phantom word.
- **Robust worker.** A bad clip returns a clean error and the worker keeps going; a wedged worker is killed (whole process tree) and restarted on the next dictation; it exits with the harness.
- **Its own Python.** The engine lives in a dedicated venv and is started by absolute path — it never touches any other Python on your machine.

## Live streaming into the message box

Click the mic — it turns red — and talk.

- **While you talk**, the phrase so far is re-transcribed about every **0.7 s** with a fast model (`base.en`, greedy decoding), and the text in the box is updated in place. The newest words may correct themselves as more audio arrives.
- **At each natural pause** (650 ms) the phrase is finalised in place with a second, more careful pass (`base.en`, beam 5), and a new phrase starts immediately.
- **5 s of silence** stops listening (or click the mic again).

How it works:

- **The box is edited like a person would.** The harness composer is a plain controlled `<textarea>`. The plugin keeps track of the stretch of text *it* wrote and rewrites only the tail that changed: `setSelectionRange` over that part, then `document.execCommand("insertText")` — exactly what selecting text and typing over it does. React and the harness's own state follow along, and undo works. If you edit inside the dictated stretch mid-dictation, the plugin lets go of that text and carries on from the caret.
- **Pause detection adapts to the room.** The room level is the 20th percentile of the last ~3 s of RMS, and speech is judged against it, so noise-suppressed or auto-gained microphones still show pauses.
- **Each phrase is its own recorder.** A `MediaRecorder` only yields a decodable file from its own start, so every phrase gets a fresh recorder on the same microphone stream, recording in 400 ms slices. The slices so far always form a decodable (unterminated) webm, which is what the live pass transcribes.

## Voice mode

A round voice button with sound bars sits where **Send** is while the message box is empty (the harness's disabled Send button is hidden, and the voice button moves to the far right). As soon as there is text in the box, Send comes back.

How to use it:

1. **Tap the voice button.** It turns red and stays red until you tap it again — the mic stays open the whole time.
2. **Talk.** Your words stream into the box as usual.
3. **Go quiet for 2 seconds** and what you said is sent. It is submitted with **Ctrl+Enter**, the harness's own gesture: a normal send when the agent is idle, a **steer** when it is busy — so talking while the agent works redirects it.
4. While voice mode is on, the **mic button becomes a mute toggle** (the microphone tracks are disabled while muted).
5. **Tap the voice button again** to leave voice mode.

Replies are read aloud by the companion **[DeepSeek-Harness-Voice-Mode](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode)** plugin. With it installed:

- **Echo protection.** Phrases that mostly match the reply being read aloud — or 1–2 word fragments during a reading — are dropped, so the speaker can never steer the agent.
- **Barge-in.** Real speech over a reading interrupts it.

Without the companion plugin, voice mode still sends and steers; replies just aren't spoken.

The two plugins coordinate through a small shared object, `window.__dshVoice` (fields `mode`, `muted`, `awaitingReply`, `speaking`, `speakingText`; events `mode`, `mute`, `speaking`, `spoken`, `stop-speaking`), created by whichever plugin loads first.

**Tuning:** the send delay is `CONVO_SEND_AFTER_MS` in `client.js` (default `2000`). Raise it if voice mode sends in the middle of a thought.

## Models and latency

Both passes use `base.en` by default (`FINAL_MODEL = "base.en"` in `client.js`). Measured on CPU (int8), `small` with beam 5 took **3–8 s** for a 10 s phrase, versus **~0.6 s** for `base.en` with the same words — too slow for text that is supposed to appear as you speak. If you need more robustness to accents or noise, set `FINAL_MODEL = "small"` and accept the slower finalisation.

## Requirements

- A running dsh install (Node ≥ 22.19 or ≥ 24)
- **Python 3.9+** (3.11 recommended)
- A microphone the harness page is allowed to use (see *Microphone permission* below)

ffmpeg is **not** required: faster-whisper decodes webm/opus itself.

## Install

```bash
# 1. clone next to your other plugins
git clone https://github.com/tonyd2wild/DeepSeek-Harness-Dictation.git ~/.dsh/plugins/dictation

# 2. give the engine its own venv
#    Windows:        py -3.11 -m venv %USERPROFILE%\.dsh\dictation-venv
#                    %USERPROFILE%\.dsh\dictation-venv\Scripts\python -m pip install -r %USERPROFILE%\.dsh\plugins\dictation\requirements.txt
#    macOS / Linux:  python3 -m venv ~/.dsh/dictation-venv
#                    ~/.dsh/dictation-venv/bin/pip install -r ~/.dsh/plugins/dictation/requirements.txt

# 3. wire it into dsh (host plane)
dsh plugin --profile <your-profile> add link:~/.dsh/plugins/dictation
#    then add a loader row to your profile's cordis.patch.yml, under `- insert:`
#    - id: dsh-plugin-dictation
#      name: 'dsh-plugin-dictation'

# 4. restart the harness and reload the page. The mic and voice buttons appear in the composer.

# 5. (optional, for spoken replies in voice mode) install DeepSeek-Harness-Voice-Mode the same way.
```

The first use downloads the Whisper models (`base.en` is ~150 MB; `small` ~500 MB if you switch to it); after that everything is quick.

## Configuration

Environment variables, read by the harness process:

| variable | default | meaning |
|---|---|---|
| `DSH_DICTATION_PYTHON` | `~/.dsh/dictation-venv/{Scripts\python.exe \| bin/python}` | interpreter that runs `worker.py` |
| `DSH_DICTATION_DEVICE` | `cpu` | `cuda` to try the GPU; any GPU failure falls back to CPU automatically |

In `client.js`:

| constant | default | meaning |
|---|---|---|
| `FINAL_MODEL` | `base.en` | model for the finalising pass (`small` = more robust, slower) |
| `CONVO_SEND_AFTER_MS` | `2000` | voice mode: quiet that sends what you said |

The request may carry `model` (`tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`, and the `.en` variants); anything else falls back to the default (`small`, or `base.en` for `fast` requests).

**GPU note:** CPU is fast enough for dictation and never competes with a GPU you use for LLMs. On Windows, CUDA inference additionally needs the cuBLAS/cuDNN 12 DLLs (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`); without them the worker logs it and stays on CPU.

## Routes

```
POST /api/dictation/transcribe   { audio: <base64 or data: URL>, mime?: string, model?: string, fast?: boolean }
  → 200 { ok: true, text, model, seconds, bytes, device }
  → 4xx/5xx { ok: false, error }

  fast: true  → a live pass: base.en, greedy decoding (unless `model` is given)

POST /api/dictation/warm         {}
  → 200 { ok: true, warmed }
  → 5xx { ok: false, error }
```

`/warm` loads both models into the worker. The browser fires it once when the button mounts, so the first words of the first dictation don't wait on a model load.

Same-origin with the harness UI, so no CORS and no token. The upload is written to a temp file and only its path is passed to the worker — no user text reaches a shell. Uploads over 25 MB are refused.

## Microphone permission

- **Browser tab:** the browser asks once; allow it.
- **Electron desktop shell:** the shell's main process must grant media permission to the harness origin (`session.setPermissionRequestHandler` / `setPermissionCheckHandler`). Without a handler, a mic request from an embedded view is not reliably granted and you get silence.
  - **Windows:** also allow *Settings → Privacy & security → Microphone → Let desktop apps access your microphone*.
  - **macOS:** the app needs a stable bundle id, `NSMicrophoneUsageDescription`, and the `com.apple.security.device.audio-input` entitlement, and the OS prompt should be raised on the user's mic click (`systemPreferences.askForMediaAccess`), not at startup — asking while the app is in the background records a silent denial. If *no* app on the Mac can get a mic prompt at all, check `nvram boot-args` for `amfi_get_out_of_my_way`: with AMFI disabled, macOS denies every new privacy prompt without showing it.

## How insertion works

The composer is a plain controlled `<textarea>`, so the plugin edits it the way a person would: select the stretch it owns, then `document.execCommand("insertText")`. If the browser refuses that, it falls back to the native value setter plus a dispatched `input` event, so React still sees the change. Only the text the plugin wrote is ever rewritten.

## Testing

Tested in headless Chromium with a fake microphone (`--use-file-for-fake-audio-capture`): words stream into the box, pre-typed text is preserved, message then steer, auto-read, barge-in, mute, and leaving voice mode — all passing.

## Sibling projects

- [DeepSeek-Harness-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Tools) — the hub index of all dsh community tools
- [DeepSeek-Harness-Voice-Mode](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode) — read-aloud + streaming speech; required for voice mode to speak replies
- [DeepSeek-Harness-Browser](https://github.com/tonyd2wild/DeepSeek-Harness-Browser) — the in-app browser pane (and an optional Electron desktop shell)
- [DeepSeek-Harness-Vision-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools) — `analyze_image` (give dsh eyes)
- [DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools) — keyless `web_search` / `web_fetch`
- [DeepSeek-Harness-Image-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Image-Tools) — `generate_image`
- [DeepSeek-Harness-Video-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Video-Tools) — `generate_video` / `check_video`

## Contributing

Issues and PRs welcome. Keep the "⚠️ Unofficial community project" banner, and keep the design constraint: **audio stays on the user's machine.**

## License

MIT — see [LICENSE](LICENSE).
