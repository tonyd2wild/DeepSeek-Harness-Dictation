# DeepSeek-Harness-Dictation

> ⚠️ **Unofficial community project.** Not affiliated with or endorsed by DeepSeek. Community tooling for the [DeepSeek Harness](https://github.com/tonyd2wild) (`dsh`) agent harness.
>
> 🔒 **Privacy note:** audio never leaves your machine. The browser records it, the harness saves it to a temp file, a local Whisper model transcribes it, and the temp file is deleted. No cloud, no API key.

**Live dictation straight into the DeepSeek Harness message box**, plus a **hands-free voice mode** for talking to the agent. Click the mic and your words appear in the composer as you speak, transcribed on your own computer by [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

**Requires dsh 0.2.0-rc.1 or newer.** Works in both dsh 0.2 surfaces: the web UI (`dsh web`) and DeepSeek's desktop app. Still on dsh 0.1.x? See [Using dsh 0.1.x?](#using-dsh-01x).

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

## How this compares to the built-in voice input

dsh 0.2 ships an **experimental voice input** of its own (`@deepseek-ai/dsh-experimental-voice-input-bundle`, local SenseVoice). It is **off by default**; you enable it from the Plugins page. It is a record-then-transcribe control: click the microphone, speak, click **Stop**, and the transcript is inserted into the draft. It also runs locally.

This plugin works differently:

- **Words stream into the box live** while you talk, instead of appearing after you press Stop.
- **Hands-free voice mode**: a pause of about 2 s sends what you said, with no button press.
- **Talk over the agent to steer it** while it is working.
- **The mic becomes a mute toggle** in voice mode, so you can stay in the conversation without being heard.
- Paired with [DeepSeek-Harness-Voice-Mode](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode), replies are read back to you.

Pick whichever fits how you work.

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

- **The box is edited like a person would.** The plugin keeps track of the stretch of text *it* wrote and rewrites only the tail that changed, the way selecting text and typing over it would. The harness's own editor state follows along. If you edit inside the dictated stretch mid-dictation, the plugin lets go of that text and carries on from the caret. See [How insertion works](#how-insertion-works).
- **Pause detection adapts to the room.** The room level is the 20th percentile of the last ~3 s of RMS, and speech is judged against it, so noise-suppressed or auto-gained microphones still show pauses.
- **Each phrase is its own recorder.** A `MediaRecorder` only yields a decodable file from its own start, so every phrase gets a fresh recorder on the same microphone stream, recording in 400 ms slices. The slices so far always form a decodable (unterminated) webm, which is what the live pass transcribes.

## Voice mode

A round voice button with sound bars sits where **Send** is while the message box is empty (the harness's disabled Send button is hidden, and the voice button moves to the far right). As soon as there is text in the box, Send comes back.

How to use it:

1. **Tap the voice button.** It turns red and stays red until you tap it again — the mic stays open the whole time.
2. **Talk.** Your words stream into the box as usual.
3. **Go quiet for 2 seconds** and what you said is sent, starting with `🎙️ ` so the agent knows it was spoken and its reply will be heard (the Voice-Mode plugin's [expressive voice](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode#expressive-voice-elevenlabs-v4--audio-tags) setup uses this to have the agent answer for the ear, with emotion). It is submitted with **Ctrl+Enter**, the harness's own gesture: a normal send when the agent is idle, a **steer** when it is busy — so talking while the agent works redirects it.
4. While voice mode is on, the **mic button becomes a mute toggle** (the microphone tracks are disabled while muted).
5. **Tap the voice button again** to leave voice mode.

Replies are read aloud by the companion **[DeepSeek-Harness-Voice-Mode](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode)** plugin. With it installed:

- **Echo protection.** Phrases that mostly match the reply being read aloud — or 1–2 stray word fragments during a reading — are dropped, so the speaker can never steer the agent.
- **Barge-in, like ChatGPT.** Start talking over a reply and:
  - it **ducks at once**: ~0.3 s of your voice drops the reading to 15 % volume (≈0.5 s from your first word), and the current phrase is recognised immediately instead of on the next caption tick;
  - it **stops** as soon as the words are yours (≈1.1 s with the local recogniser). Short commands count — "stop", "wait", "hold on", "hang on", "okay", "no", "actually", "sorry" — unless the reply itself says them, and so do **three or more words that are not in the reply**, even when the mic also caught the reply underneath;
  - **echo or noise** only ducks it; full volume returns after 1.5 s of quiet.

Without the companion plugin, voice mode still sends and steers; replies just aren't spoken.

The two plugins coordinate through a small shared object, `window.__dshVoice` (fields `mode`, `muted`, `awaitingReply`, `speaking`, `speakingText`, `ducked`, `duckVolume`, `lastVoiceAt`; events `mode`, `mute`, `speaking`, `spoken`, `stop-speaking`, `duck`, `unduck`), created by whichever plugin loads first.

**Tuning** (in `client.js`): the send delay is `CONVO_SEND_AFTER_MS` (default `2000`); raise it if voice mode sends in the middle of a thought. Barge-in: `BARGE_DUCK_MS` (300), `BARGE_RELEASE_MS` (1500), `DUCK_VOLUME` (0.15), and the command words in `BARGE_WORDS`. The spoken-message marker is `VOICE_MARKER`.

## Models and latency

Both passes use `base.en` by default (`FINAL_MODEL = "base.en"` in `client.js`). Measured on CPU (int8), `small` with beam 5 took **3–8 s** for a 10 s phrase, versus **~0.6 s** for `base.en` with the same words — too slow for text that is supposed to appear as you speak. If you need more robustness to accents or noise, set `FINAL_MODEL = "small"` and accept the slower finalisation.

## Requirements

- **dsh 0.2.0-rc.1 or newer** (Node ≥ 22.19 or ≥ 24)
- **Python 3.9+** (3.11 recommended)
- A microphone the harness page is allowed to use (see *Microphone permission* below)

ffmpeg is **not** required: faster-whisper decodes webm/opus itself.

## Install

dsh 0.2 installs plugins **per profile**. Each surface has its own profile:

| you use | profile | profile folder |
|---|---|---|
| the web UI (`dsh web`) | `web` | `~/.dsh/profiles/web` |
| DeepSeek's desktop app | `desktop` | `~/.dsh/profiles/desktop` |

Install into whichever profile you use (or both — repeat steps 3–4 for each). There is no `settings.yaml` in 0.2: settings are rows in the profile's `cordis.patch.yml`, and upgrading from 0.1 migrates them there.

```bash
# 1. clone next to your other plugins
git clone https://github.com/tonyd2wild/DeepSeek-Harness-Dictation.git ~/.dsh/plugins/dictation

# 2. give the engine its own venv
#    Windows:        py -3.11 -m venv %USERPROFILE%\.dsh\dictation-venv
#                    %USERPROFILE%\.dsh\dictation-venv\Scripts\python -m pip install -r %USERPROFILE%\.dsh\plugins\dictation\requirements.txt
#    macOS / Linux:  python3 -m venv ~/.dsh/dictation-venv
#                    ~/.dsh/dictation-venv/bin/pip install -r ~/.dsh/plugins/dictation/requirements.txt

# 3. link it into the profile (use `desktop` instead of `web` for the desktop app)
dsh plugin --profile web add link:$HOME/.dsh/plugins/dictation
#    Windows PowerShell:
#    dsh plugin --profile web add "link:$env:USERPROFILE\.dsh\plugins\dictation"
```

**4. Enable it** with a loader row in that profile's `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml` or `~/.dsh/profiles/desktop/cordis.patch.yml`). If the file already has a `- insert:` list, add the two lines to it; otherwise append:

```yaml
- insert:
    - id: dsh-plugin-dictation
      name: 'dsh-plugin-dictation'
```

**5. Restart.**

- **Web UI:** stop `dsh web` and start it again, then open the `/?token=…` link it prints (0.2 asks each browser to log in once per address) or reload a tab that is already logged in.
- **Desktop app:** quit the app completely and reopen it.

The mic and voice buttons appear in the composer.

**6. (optional)** For spoken replies in voice mode, install [DeepSeek-Harness-Voice-Mode](https://github.com/tonyd2wild/DeepSeek-Harness-Voice-Mode) the same way.

The first use downloads the Whisper models (`base.en` is ~150 MB; `small` ~500 MB if you switch to it); after that everything is quick.

> **Do not install a 0.1.x build of this plugin on dsh 0.2.** In 0.2 a client plugin that reads a service the page does not declare throws, and **one failing client plugin stops the whole UI from booting** ("Failed to load plugins"), not just the mic button. If the UI will not load after an install, remove the `dsh-plugin-dictation` row from `cordis.patch.yml`, restart, and install the current version.

### Checking that it loaded

In the browser's developer tools (Network tab), the browser half loads as `plugins/??dsh-plugin-dictation/client.js&rev=…`. The 0.1 path `/plugins/dsh-plugin-dictation/client.js` no longer exists in 0.2.

## Using dsh 0.1.x?

This version needs dsh 0.2.0-rc.1 or newer. The last release for dsh 0.1.x is preserved at the **`dsh-0.1`** tag:

```bash
git clone --branch dsh-0.1 https://github.com/tonyd2wild/DeepSeek-Harness-Dictation.git ~/.dsh/plugins/dictation
```

Follow the README at that tag to install it. When you upgrade dsh to 0.2, switch to the current version *before* you restart (see the warning above).

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

Same-origin with the harness UI, so no CORS and no extra token. The upload is written to a temp file and only its path is passed to the worker — no user text reaches a shell. Uploads over 25 MB are refused.

## Microphone permission

- **Browser tab (web UI):** the browser asks once; allow it. Browsers only offer the microphone on HTTPS or on `localhost`/loopback addresses.
- **Desktop app or another Electron shell:** the operating system has to allow the app to use the microphone.
  - **Windows:** allow *Settings → Privacy & security → Microphone → Let desktop apps access your microphone*.
  - **macOS:** allow the app under *System Settings → Privacy & Security → Microphone*. If *no* app on the Mac can get a mic prompt at all, check `nvram boot-args` for `amfi_get_out_of_my_way`: with AMFI disabled, macOS denies every new privacy prompt without showing it.
  - **If you build your own Electron shell:** its main process must grant media permission to the harness origin (`session.setPermissionRequestHandler` / `setPermissionCheckHandler`); without a handler, a mic request from an embedded view is not reliably granted and you get silence. On macOS it also needs a stable bundle id, `NSMicrophoneUsageDescription`, the `com.apple.security.device.audio-input` entitlement, and should raise the OS prompt on the user's mic click (`systemPreferences.askForMediaAccess`), not at startup.

## How insertion works

In dsh 0.2 the composer is a **Lexical rich-text editor** (a `contentEditable` marked `data-composer-input="true"`), not a `<textarea>`. Lexical ignores a synthetic `insertText` over a selection, so the plugin edits it with the two events Lexical does handle itself:

1. select the stretch the plugin owns and dispatch a `beforeinput` event with `inputType: "deleteContentBackward"`;
2. put the caret there and dispatch a `paste` `ClipboardEvent` carrying the new text.

Offsets are measured over the editor's plain text. Edits are asynchronous, so they are serialised: while one write runs, newer text just marks the box dirty and the newest version is written next. Voice mode also waits for pending writes before it sends. Only the text the plugin wrote is ever rewritten.

On a plain `<textarea>` (dsh 0.1) the same code still selects the stretch and uses `document.execCommand("insertText")`, falling back to the native value setter plus a dispatched `input` event.

## Testing

- **On dsh 0.2.0-rc.1**, on the real harness page with a fake microphone (Chromium `--use-file-for-fake-audio-capture`): words stream into the Lexical composer while talking, text typed beforehand is kept, both test sentences land verbatim and in order, the harness's Send button sees the text, dictation stops by itself after the silence, and nothing is sent — all passing.
- On a test page in headless Chromium with a fake microphone: message then steer, auto-read, barge-in, mute, and leaving voice mode — all passing. On 0.2, voice mode sends with the same Ctrl+Enter gesture; that path has not yet been exercised in a live 0.2 session.
- **Barge-in (this release)**, headless Chromium, fake microphone, both plugins, a recogniser answering in 800 ms: talking over a reply ducks it in ~0.5 s and stops it at ~1.1 s; echo-only ducks it, does not stop it, and restores full volume after quiet; unit checks that "stop", "wait", "hold on" and echo + three new words count as you, while echoed phrases stay echo — 13/13.

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
