# DeepSeek-Harness-Dictation

> ⚠️ **Unofficial community project.** Not affiliated with or endorsed by DeepSeek. Community tooling for the [DeepSeek Harness](https://github.com/tonyd2wild) (`dsh`) agent harness.
>
> 🔒 **Privacy note:** audio never leaves your machine. The browser records it, the harness saves it to a temp file, a local Whisper model transcribes it, and the temp file is deleted. No cloud, no API key.

A **push-to-dictate microphone button** in the DeepSeek Harness composer. Click the mic, talk, click again — the words land in the message box, transcribed on your own computer by [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

```
🎙️ click → speak → click   →   "Open the preview pane and show me the latest build."
```

## Why not the browser's built-in speech recognition?

Chrome's `SpeechRecognition` is not on-device: it ships your audio to Google. Inside an Electron desktop shell (no Google API key) it fails with a `network` error — same page, same code, works in Chrome, dies in the app. This plugin takes Google out of the path entirely:

```
getUserMedia → MediaRecorder (webm/opus) → POST /api/dictation/transcribe → local faster-whisper → text into the composer
```

It behaves the same in a browser tab, in a desktop shell, and fully offline.

## What you get

- **Mic button** beside the composer's send controls, with a small status hint (level meter while recording, then "Transcribing…"). Finished hints fade after a few seconds.
- **Fast after the first phrase.** One long-lived worker keeps the model loaded: measured **~2 s** for a 4.5 s clip on CPU (`small`, int8), after a one-time model load.
- **No hallucinated "You".** Silence is filtered out (VAD) before Whisper sees it, so an empty recording returns nothing instead of Whisper's classic phantom word.
- **Robust worker.** A bad clip returns a clean error and the worker keeps going; a wedged worker is killed (whole process tree) and restarted on the next dictation; it exits with the harness.
- **Its own Python.** The engine lives in a dedicated venv and is started by absolute path — it never touches any other Python on your machine.

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

# 4. restart the harness and reload the page. The mic button appears in the composer.
```

The first dictation downloads the Whisper model (~500 MB for `small`) and loads it; every one after that is quick.

## Configuration

Environment variables, read by the harness process:

| variable | default | meaning |
|---|---|---|
| `DSH_DICTATION_PYTHON` | `~/.dsh/dictation-venv/{Scripts\python.exe \| bin/python}` | interpreter that runs `worker.py` |
| `DSH_DICTATION_DEVICE` | `cpu` | `cuda` to try the GPU; any GPU failure falls back to CPU automatically |

The request may carry `model` (`tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`, and the `.en` variants); anything else falls back to `small`.

**GPU note:** `small` on CPU is already fast enough for dictation and never competes with a GPU you use for LLMs. On Windows, CUDA inference additionally needs the cuBLAS/cuDNN 12 DLLs (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`); without them the worker logs it and stays on CPU.

## Route

```
POST /api/dictation/transcribe   { audio: <base64 or data: URL>, mime?: string, model?: string }
  → 200 { ok: true, text, model, seconds, bytes, device }
  → 4xx/5xx { ok: false, error }
```

Same-origin with the harness UI, so no CORS and no token. The upload is written to a temp file and only its path is passed to the worker — no user text reaches a shell. Uploads over 25 MB are refused.

## Microphone permission

- **Browser tab:** the browser asks once; allow it.
- **Electron desktop shell:** the shell's main process must grant media permission to the harness origin (`session.setPermissionRequestHandler` / `setPermissionCheckHandler`). Without a handler, a mic request from an embedded view is not reliably granted and you get silence.
  - **Windows:** also allow *Settings → Privacy & security → Microphone → Let desktop apps access your microphone*.
  - **macOS:** the app needs a stable bundle id, `NSMicrophoneUsageDescription`, and the `com.apple.security.device.audio-input` entitlement, and the OS prompt should be raised on the user's mic click (`systemPreferences.askForMediaAccess`), not at startup — asking while the app is in the background records a silent denial. If *no* app on the Mac can get a mic prompt at all, check `nvram boot-args` for `amfi_get_out_of_my_way`: with AMFI disabled, macOS denies every new privacy prompt without showing it.

## How insertion works

Writing into another package's composer is the fragile part, so three strategies are tried in order and the first that works wins: the session event bus (`slash/input-insert-text`), then `document.execCommand("insertText")` on the focused composer, then a native value setter plus an `input` event.

## Sibling projects

- [DeepSeek-Harness-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Tools) — the hub index of all dsh community tools
- [DeepSeek-Harness-Browser](https://github.com/tonyd2wild/DeepSeek-Harness-Browser) — the in-app browser pane (and an optional Electron desktop shell)
- [DeepSeek-Harness-Vision-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools) — `analyze_image` (give dsh eyes)
- [DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools) — keyless `web_search` / `web_fetch`
- [DeepSeek-Harness-Image-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Image-Tools) — `generate_image`
- [DeepSeek-Harness-Video-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Video-Tools) — `generate_video` / `check_video`

## Contributing

Issues and PRs welcome. Keep the "⚠️ Unofficial community project" banner, and keep the design constraint: **audio stays on the user's machine.**

## License

MIT — see [LICENSE](LICENSE).
