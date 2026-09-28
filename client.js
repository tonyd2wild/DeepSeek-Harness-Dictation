/**
 * dsh-plugin-dictation — BROWSER half.
 *
 * Requires dsh 0.2.0-rc.1 or newer (0.1.x builds live on the dsh-0.1 tag).
 *
 * Served at plugins/??dsh-plugin-dictation/client.js by the host's client-modules
 * scanner (package.json declares dsh.client.platform "web") and injected via
 * window.__DSH_BOOT__. Executing it only REGISTERS a factory through
 * window.__ModuleLoader__.load({id, factory}).
 *
 * ARCHITECTURE — WHY IT RECORDS INSTEAD OF USING SpeechRecognition
 *   The first version used the Web Speech API, as most dictation does. It failed
 *   with a `network` error in the Electron desktop shell, and the reason is
 *   structural: Chrome's SpeechRecognition is NOT on-device. It ships the audio
 *   to Google, and an Electron build without Google's API keys cannot complete
 *   that round-trip. It worked in a real Chrome window and failed in the app —
 *   the same page, the same code.
 *
 *   So this version takes Google out of the path entirely:
 *     getUserMedia -> MediaRecorder (webm/opus) -> POST to
 *     /api/dictation/transcribe -> local faster-whisper -> text into composer.
 *
 *   Nothing leaves the machine, no API key is involved, and it behaves
 *   identically in the Electron shell, in Chrome, and fully offline.
 *
 * LIVE STREAMING INTO THE MESSAGE BOX (v2)
 *   v1 was "click to record, click again to transcribe". v2 streams: words
 *   appear in the composer and grow in place while you talk, each phrase is
 *   finalised at a natural pause, and a long silence stops listening. See
 *   "the dictation engine" below for how phrases are cut and how the box is
 *   edited without touching text the human typed.
 *
 * VOICE MODE
 *   A second button runs a hands-free conversation: it sends (or steers) after
 *   a quiet spell and cooperates with the companion read-aloud plugin through
 *   window.__dshVoice. See "voice mode" below.
 *
 * INSERTION
 *   Writing into another package's composer is the fragile part. In dsh 0.2
 *   the composer is a Lexical contentEditable ([data-composer-input="true"]),
 *   which ignores a synthetic insertText over a selection. The engine therefore
 *   selects the stretch it owns, deletes it with a `beforeinput`
 *   deleteContentBackward, and pastes the new text with a ClipboardEvent;
 *   Lexical applies both itself. Writes are serialised so they never overlap.
 *   On a plain <textarea> (dsh 0.1) it still selects the stretch and uses
 *   document.execCommand("insertText"), falling back to the native value
 *   setter plus a dispatched "input" event. The v1 layered
 *   helpers (session event bus "slash/input-insert-text", then execCommand,
 *   then the native setter) are still defined below.
 *
 * @module dsh-plugin-dictation/client
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-dictation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var useEffect = react.useEffect;
		var useState = react.useState;
		var useRef = react.useRef;
		var useCallback = react.useCallback;
		var h = react.createElement;

		var TRANSCRIBE_PATH = "/api/dictation/transcribe";

		/**
		 * Which recording formats this browser can produce.
		 *
		 * Electron ships Chromium without licensed codecs, so plain "audio/webm"
		 * can fail while opus succeeds, and Safari differs again. Probed in
		 * preference order rather than assumed.
		 */
		function pickMimeType() {
			if (typeof MediaRecorder === "undefined") return null;
			var candidates = [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/ogg;codecs=opus",
				"audio/mp4"
			];
			for (var i = 0; i < candidates.length; i++) {
				try {
					if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
				} catch (e) { /* not supported: keep probing */ }
			}
			return "";   // let the browser choose its own default
		}

		/** Can this page record at all? */
		function canRecord() {
			return typeof navigator !== "undefined"
				&& Boolean(navigator.mediaDevices)
				&& typeof navigator.mediaDevices.getUserMedia === "function"
				&& typeof MediaRecorder !== "undefined";
		}

		// ── composer insertion: three strategies, first success wins ─────────
		/**
		 * Find the composer's editable element.
		 *
		 * Deliberately broad, because the composer's DOM shape is another
		 * package's private business: any visible contenteditable or textarea is
		 * a candidate, and the LAST match in document order is the best guess.
		 */
		function findComposer() {
			// dsh 0.2: the composer is a Lexical contentEditable marked data-composer-input.
			var marked = document.querySelectorAll('[data-composer-input="true"]');
			for (var k = marked.length - 1; k >= 0; k--) {
				var mr = marked[k].getBoundingClientRect();
				if (mr.width > 0 && mr.height > 0) return marked[k];
			}
			var nodes = document.querySelectorAll('[contenteditable="true"], textarea');
			var best = null;
			for (var i = 0; i < nodes.length; i++) {
				var r = nodes[i].getBoundingClientRect();
				if (r.width > 0 && r.height > 0) best = nodes[i];
			}
			return best;
		}

		/** Dispatch a synthetic input event so React sees the change. */
		function notifyInput(el) {
			el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		}

		/** Strategy 2/3 against a concrete element. Returns a name or null. */
		function insertIntoElement(el, text) {
			if (!el) return null;
			try { el.focus({ preventScroll: true }); } catch (e) { /* best-effort */ }

			try {
				if (document.execCommand && document.execCommand("insertText", false, text)) {
					notifyInput(el);
					return "execCommand";
				}
			} catch (e) { /* fall through to the setter path */ }

			try {
				var proto = el instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLElement.prototype;
				var desc = Object.getOwnPropertyDescriptor(proto, "value");
				if (desc && desc.set) {
					desc.set.call(el, (el.value || "") + text);
					notifyInput(el);
					return "native-setter";
				}
				if (el.isContentEditable) {
					el.appendChild(document.createTextNode(text));
					notifyInput(el);
					return "text-node";
				}
			} catch (e) { /* give up on this strategy */ }

			return null;
		}

		/**
		 * Insert dictated text into the composer.
		 *
		 * @param sessionEvents - Optional session event bus (best path).
		 * @param text - Transcript to insert.
		 * @returns the name of the strategy that worked, or null.
		 */
		function insertTranscript(sessionEvents, text) {
			if (!text) return null;

			// Strategy 1: the session event bus, the same path slash commands use.
			try {
				if (sessionEvents && typeof sessionEvents.dispatch === "function") {
					var handled = sessionEvents.dispatch("slash/input-insert-text", { text: text });
					if (handled !== false) return "session-event";
				}
			} catch (e) { /* bus absent or rejected it; fall through */ }

			return insertIntoElement(findComposer(), text);
		}

		// ── audio upload ─────────────────────────────────────────────────────
		/** Blob -> bare base64 (no data: prefix), which the host route accepts. */
		function blobToBase64(blob) {
			return new Promise(function (resolve, reject) {
				var reader = new FileReader();
				reader.onerror = function () { reject(new Error("could not read the recording")); };
				reader.onload = function () {
					var s = String(reader.result || "");
					var comma = s.indexOf(",");
					resolve(comma >= 0 ? s.slice(comma + 1) : s);
				};
				reader.readAsDataURL(blob);
			});
		}

		/** POST the recording to the host's local whisper route. */
		function transcribe(blob) {
			return blobToBase64(blob).then(function (audio) {
				return fetch(TRANSCRIBE_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ audio: audio, mime: blob.type })
				});
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (body) {
					if (!r.ok || !body || body.ok !== true) {
						throw new Error((body && body.error) || ("transcription failed (HTTP " + r.status + ")"));
					}
					return body;
				});
			});
		}

		// ── the dictation engine ─────────────────────────────────────────────
		/**
		 * Hands-free dictation that streams STRAIGHT INTO THE MESSAGE BOX.
		 * Shared by the mic button (dictate, you press Send) and the voice-mode
		 * button (conversation: it sends after a pause and reads the reply aloud).
		 *
		 * While you talk, your words appear in the message box and grow in place
		 * (re-recognised about every 0.7 s, so the newest words may correct
		 * themselves). At each natural pause the phrase is finalised in place.
		 * A longer silence (autoStopMs) ends the listening.
		 *
		 * HOW THE BOX IS EDITED
		 *   The harness composer is a plain controlled <textarea>. The engine keeps
		 *   track of the stretch of text IT wrote and updates only that stretch:
		 *   select the part that changed and execCommand("insertText"), exactly
		 *   what a person selecting text and typing over it does, so the harness's
		 *   own state follows along (and undo works). Text the human typed outside
		 *   that stretch is never touched; if they edit inside it mid-dictation,
		 *   the engine stops owning that text and carries on from the caret.
		 *
		 * HOW PHRASES ARE CUT
		 *   A MediaRecorder only yields a decodable file from its own start, so each
		 *   phrase is its own recorder on the same microphone stream, recording in
		 *   400 ms slices. The slices so far always form a decodable (unterminated)
		 *   webm, which the live pass transcribes. At a pause the recorder is
		 *   stopped, the whole phrase is transcribed once more (beam search) and
		 *   replaces the live text in place, and a new recorder starts at once.
		 *
		 * PAUSE DETECTION
		 *   Room level = the 20th percentile of the last ~3 s; speech is judged
		 *   against it, so a noise-suppressed, auto-gained mic still shows pauses.
		 */
		var PAUSE_MS = 650;          // silence that ends a phrase
		var MAX_PHRASE_MS = 12000;   // force a cut in a long unbroken run
		var TICK_MS = 80;            // voice-activity check interval
		var LIVE_EVERY_MS = 700;     // live re-recognition interval
		var SLICE_MS = 400;          // recorder slice length
		var FINAL_MODEL = "base.en"; // "small" is more robust to accents/noise but ~5x slower on CPU
		var WARM_PATH = "/api/dictation/warm";
		var warmRequested = false;

		function warmOnce() {
			if (warmRequested) return;
			warmRequested = true;
			fetch(WARM_PATH, { method: "POST" }).catch(function () { warmRequested = false; });
		}

		/** Transcribe a blob with explicit options (fast = live pass). */
		function transcribeWith(blob, opts) {
			return blobToBase64(blob).then(function (audio) {
				return fetch(TRANSCRIBE_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(Object.assign({ audio: audio, mime: blob.type }, opts || {}))
				});
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (body) {
					if (!r.ok || !body || body.ok !== true) throw new Error((body && body.error) || ("transcription failed (HTTP " + r.status + ")"));
					return body;
				});
			});
		}

		var HALLUCINATIONS = ["you", "you.", "thank you", "thank you.", "thanks for watching!", "thanks for watching.", "bye.", "bye"];
		function isHallucination(text, seconds) {
			return seconds < 2.5 && HALLUCINATIONS.indexOf(String(text).trim().toLowerCase()) >= 0;
		}

		/** Plain text of the composer, the coordinate space all offsets use. */
		function composerText(el) {
			return el.isContentEditable ? (el.textContent || "") : (el.value || "");
		}

		/** Where the caret is, as a text offset (end of text if it is elsewhere). */
		function caretOffset(el) {
			if (!el.isContentEditable) return typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
			var sel = window.getSelection();
			if (sel && sel.rangeCount && el.contains(sel.focusNode)) {
				var r = document.createRange();
				r.selectNodeContents(el);
				r.setEnd(sel.focusNode, sel.focusOffset);
				return r.toString().length;
			}
			return composerText(el).length;
		}

		/** Text offset -> DOM position inside a contentEditable. */
		function domPos(root, off) {
			var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			var n, last = null;
			while ((n = w.nextNode())) {
				last = n;
				if (off <= n.data.length) return [n, off];
				off -= n.data.length;
			}
			return last ? [last, last.data.length] : [root, root.childNodes.length];
		}

		function selectText(el, from, to) {
			var a = domPos(el, from), b = domPos(el, to);
			var r = document.createRange();
			r.setStart(a[0], a[1]);
			r.setEnd(b[0], b[1]);
			var sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
			document.dispatchEvent(new Event("selectionchange"));
		}

		function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

		/**
		 * Replace [from, to) of the composer the way a person would.
		 * textarea (dsh 0.1): select + execCommand("insertText").
		 * contentEditable/Lexical (dsh 0.2): delete the old stretch with a
		 * deleteContentBackward beforeinput, then PASTE the new text at that spot.
		 * Lexical applies both itself; a synthetic insertText over a selection is
		 * left to the browser and does nothing, which is why it is not used.
		 */
		function replaceRange(el, from, to, text) {
			if (el.isContentEditable) {
				return (async function () {
					if (to > from) {
						selectText(el, from, to);
						await wait(30);
						el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
						await wait(40);
					}
					if (text) {
						selectText(el, from, from);
						await wait(30);
						var dt = new DataTransfer();
						dt.setData("text/plain", text);
						el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
						await wait(40);
					}
				})();
			}
			el.focus({ preventScroll: true });
			el.setSelectionRange(from, to);
			var ok = false;
			try {
				ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete", false);
			} catch (e) { ok = false; }
			if (!ok) {
				// Fallback: native setter + input event (React still sees it).
				var v = el.value;
				var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
				desc.set.call(el, v.slice(0, from) + text + v.slice(to));
				el.setSelectionRange(from + text.length, from + text.length);
				el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
			}
			return Promise.resolve();
		}

		/**
		 * Make the stretch this dictation owns read `desired`, changing only the
		 * part that differs so the caret and the rest of the text stay put.
		 * Returns a promise of true/false (false = no composer found).
		 */
		function writeOwned(live, desired) {
			var el = live.box && document.contains(live.box) ? live.box : findComposer();
			if (!el || (!el.isContentEditable && typeof el.setSelectionRange !== "function")) return Promise.resolve(false);
			if (el !== live.box) {
				// First write (or the composer was re-mounted): anchor at the caret.
				live.box = el;
				live.anchor = caretOffset(el);
				live.written = "";
				live.lead = live.anchor > 0 && !/\s$/.test(composerText(el).slice(0, live.anchor)) ? " " : "";
			}
			var cur = composerText(el);
			if (cur.substr(live.anchor, live.written.length) !== live.written) {
				// The human edited inside our stretch (or the box was sent/cleared):
				// leave it to them and carry on from wherever the caret is now.
				live.anchor = caretOffset(el);
				live.written = "";
				live.lead = live.anchor > 0 && !/\s$/.test(cur.slice(0, live.anchor)) ? " " : "";
				live.parts = [];
				desired = live.phrase && live.phrase.text ? live.phrase.text : "";
			}
			var target = desired ? live.lead + desired : "";
			var common = 0;
			var max = Math.min(target.length, live.written.length);
			while (common < max && target.charCodeAt(common) === live.written.charCodeAt(common)) common++;
			if (common === target.length && common === live.written.length) return Promise.resolve(true);
			var from = live.anchor + common, to = live.anchor + live.written.length, text = target.slice(common);
			live.written = target;
			return replaceRange(el, from, to, text).then(function () { return true; });
		}

		/**
		 * Start listening. Returns a controller: { stop(), setMuted(bool) }.
		 *
		 * hooks: onListening(bool), onPending(n), onError(msg),
		 *        onEnd({ said })     -- after listening stopped AND every phrase is final
		 *        filter(text, final) -- optional; return "" to drop a phrase (echo filter)
		 *        onUtterance()       -- CONTINUOUS mode: you went quiet for sendAfterMs
		 *                               after saying something and every phrase is final;
		 *                               the text is in the box, ready to send. Listening
		 *                               carries on and the next words start a new stretch.
		 * opts:  autoStopMs  -- silence that ends the listening (dictation mode)
		 *        continuous  -- never stop on silence; call onUtterance instead
		 *        sendAfterMs -- the silence that counts as "done talking" (continuous)
		 */
		function startDictation(hooks, opts) {
			var h = hooks || {};
			var o = opts || {};
			var continuous = !!o.continuous;
			var autoStopMs = o.autoStopMs || 5000;
			var sendAfterMs = o.sendAfterMs || 5000;
			var filter = h.filter || function (t) { return t; };
			var live = {
				stream: null, mime: pickMimeType(), parts: [], stopped: false, ended: false, muted: false,
				phrase: null, timer: null, liveTimer: null, audioCtx: null,
				lastVoiceAt: Date.now(), levels: [], said: false,
				box: null, anchor: 0, written: "", lead: ""
			};

			function pendingCount() { return live.parts.filter(function (p) { return !p.done; }).length; }

			function maybeEnd() {
				if (!live.stopped || live.ended || pendingCount() > 0) return;
				live.ended = true;
				if (h.onEnd) h.onEnd({ said: live.said });
			}

			function desiredText() {
				var texts = live.parts.map(function (p) { return p.text; });
				if (live.phrase && live.phrase.text) texts.push(live.phrase.text);
				var desired = texts.filter(Boolean).join(" ");
				if (desired) live.said = true;
				return desired;
			}

			/**
			 * Bring the box up to date. Writes are async on dsh 0.2's editor, so
			 * they are serialised: while one runs, later changes just mark the box
			 * dirty and the loop writes the newest text once it finishes.
			 */
			function render() {
				live.dirty = true;
				if (h.onPending) h.onPending(pendingCount());
				if (live.flushing) return;
				live.flushing = true;
				(async function () {
					while (live.dirty) {
						live.dirty = false;
						var ok = await writeOwned(live, desiredText());
						if (!ok && h.onError) h.onError("Could not reach the message box");
					}
					live.flushing = false;
				})();
			}

			/** Continuous mode: the stretch was sent; the next words start a new one. */
			function newStretch() {
				live.parts = [];
				live.box = null;
				live.written = "";
				live.said = false;
			}

			function refreshLive() {
				var p = live.phrase;
				if (!p || !p.hadSpeech || p.busy || !p.chunks.length) return;
				p.busy = true;
				var blob = new Blob(p.chunks.slice(), { type: live.mime || "audio/webm" });
				transcribeWith(blob, { fast: true }).then(function (body) {
					var text = (body.text || "").trim();
					if (live.phrase === p && !p.closed && !isHallucination(text, (Date.now() - p.startedAt) / 1000)) {
						p.text = filter(text, false);
						render();
					}
				}).catch(function () { /* a missed live pass is harmless; the final pass still comes */ })
					.then(function () { p.busy = false; });
			}

			function startPhrase() {
				var rec = live.mime ? new MediaRecorder(live.stream, { mimeType: live.mime }) : new MediaRecorder(live.stream);
				var p = { rec: rec, chunks: [], startedAt: Date.now(), hadSpeech: false, text: "", busy: false, closed: false, done: false };
				rec.ondataavailable = function (ev) { if (ev.data && ev.data.size > 0) p.chunks.push(ev.data); };
				rec.onstop = function () {
					p.closed = true;
					if (!p.hadSpeech || !p.chunks.length) { maybeEnd(); return; }
					var seconds = (Date.now() - p.startedAt) / 1000;
					// The phrase keeps its place in the box; its live text stays
					// visible until the final pass replaces it.
					live.parts.push(p);
					render();
					transcribeWith(new Blob(p.chunks, { type: live.mime || "audio/webm" }), { model: FINAL_MODEL })
						.then(function (body) {
							var text = (body.text || "").trim();
							p.text = isHallucination(text, seconds) ? "" : filter(text, true);
						})
						.catch(function (e) {
							// Keep what the live pass heard rather than losing the phrase.
							if (!p.text && h.onError) h.onError("Transcription failed: " + (e && e.message ? e.message : e));
						})
						.then(function () { p.done = true; render(); maybeEnd(); });
				};
				rec.start(SLICE_MS);
				live.phrase = p;
			}

			function cutPhrase(andContinue) {
				var p = live.phrase;
				live.phrase = null;
				if (p) { try { p.rec.stop(); } catch (e) { /* already stopped */ } }
				if (andContinue && !live.stopped) startPhrase();
			}

			function stop() {
				if (live.stopped) return;
				live.stopped = true;
				clearInterval(live.timer);
				clearInterval(live.liveTimer);
				var hadPhrase = !!live.phrase;
				cutPhrase(false);
				try { live.stream && live.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* released */ }
				try { live.audioCtx && live.audioCtx.close(); } catch (e) { /* fine */ }
				if (h.onListening) h.onListening(false);
				if (!hadPhrase) maybeEnd();   // otherwise the recorder's onstop ends it
			}

			/** Mute: the mic delivers silence (tracks disabled) and the current phrase is finished. */
			function setMuted(m) {
				live.muted = !!m;
				try { live.stream && live.stream.getAudioTracks().forEach(function (t) { t.enabled = !live.muted; }); } catch (e) { /* fine */ }
				if (live.muted && live.phrase && live.phrase.hadSpeech) cutPhrase(true);
			}

			if (!canRecord()) {
				if (h.onError) h.onError("This browser cannot record audio");
				live.stopped = true;
				setTimeout(maybeEnd, 0);
				return { stop: function () {}, setMuted: function () {} };
			}

			navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			}).then(function (stream) {
				if (live.stopped) { stream.getTracks().forEach(function (t) { t.stop(); }); maybeEnd(); return; }
				live.stream = stream;
				if (live.muted) setMuted(true);
				var AC = window.AudioContext || window.webkitAudioContext;
				live.audioCtx = new AC();
				var analyser = live.audioCtx.createAnalyser();
				analyser.fftSize = 1024;
				live.audioCtx.createMediaStreamSource(stream).connect(analyser);
				var buf = new Float32Array(analyser.fftSize);

				startPhrase();
				if (h.onListening) h.onListening(true);

				live.timer = setInterval(function () {
					analyser.getFloatTimeDomainData(buf);
					var sum = 0;
					for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
					var rms = Math.sqrt(sum / buf.length);
					live.levels.push(rms);
					if (live.levels.length > 40) live.levels.shift();
					var sorted = live.levels.slice().sort(function (a, b) { return a - b; });
					var floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
					var speaking = !live.muted && rms > Math.max(0.008, floor * 2.5 + 0.003);
					var now = Date.now();
					var p = live.phrase;
					if (speaking) {
						live.lastVoiceAt = now;
						if (p) p.hadSpeech = true;
					}
					var quietFor = now - live.lastVoiceAt;
					if (p && p.hadSpeech && (quietFor >= PAUSE_MS || now - p.startedAt >= MAX_PHRASE_MS)) cutPhrase(true);
					if (!continuous) {
						if (quietFor >= autoStopMs) stop();
						return;
					}
					// Continuous: done talking = quiet long enough, nothing still
					// being recorded or finalised, and something was actually said.
					var p2 = live.phrase;
					if (live.said && quietFor >= sendAfterMs && !(p2 && p2.hadSpeech) && pendingCount() === 0 && !live.flushing) {
						var fire = h.onUtterance;
						newStretch();
						if (fire) fire();
					}
				}, TICK_MS);

				live.liveTimer = setInterval(refreshLive, LIVE_EVERY_MS);
			}).catch(function (e) {
				var name = e && e.name;
				var m = (name === "NotAllowedError" || name === "SecurityError") ? "Microphone blocked — allow it for this app"
					: (name === "NotFoundError" || name === "DevicesNotFoundError") ? "No microphone found"
					: "Microphone error: " + (name || e);
				if (h.onError) h.onError(m);
				live.stopped = true;
				if (h.onListening) h.onListening(false);
				maybeEnd();
			});

			return { stop: stop, setMuted: setMuted };
		}

		// ── the voice-mode bus (shared with dsh-plugin-speech) ───────────────
		/**
		 * window.__dshVoice, created by whichever plugin loads first (same shape
		 * in both). Fields:
		 *   mode          -- voice mode is on
		 *   muted         -- voice mode's mic is muted
		 *   awaitingReply -- a message was sent; read the next finished reply aloud
		 *   speaking      -- a reply is being read aloud right now
		 *   speakingText  -- what is being read (the echo filter compares against it)
		 * Events: "mode", "mute", "speaking", "spoken", "stop-speaking".
		 */
		function voiceBus() {
			if (!window.__dshVoice) {
				window.__dshVoice = {
					mode: false,
					awaitingReply: false,
					listeners: new Set(),
					on: function (fn) { this.listeners.add(fn); var self = this; return function () { self.listeners.delete(fn); }; },
					emit: function (type) { this.listeners.forEach(function (fn) { try { fn(type); } catch (e) {} }); }
				};
			}
			var b = window.__dshVoice;
			if (b.muted === undefined) b.muted = false;
			if (b.speaking === undefined) b.speaking = false;
			if (b.speakingText === undefined) b.speakingText = "";
			return b;
		}

		/** Re-render a component whenever the voice bus says something. */
		function useVoiceBus() {
			var bus = voiceBus();
			var tick = useState(0);
			useEffect(function () {
				return bus.on(function () { tick[1](function (n) { return n + 1; }); });
			}, []);
			return bus;
		}

		// ── shared bits for both buttons ─────────────────────────────────────

		function useFadingMessage() {
			var st = useState(null);
			useEffect(function () {
				if (!st[0]) return;
				var t = setTimeout(function () { st[1](null); }, 5000);
				return function () { clearTimeout(t); };
			}, [st[0]]);
			return st;
		}

		function hintBubble(msg) {
			return msg ? h("span", {
				style: {
					position: "absolute",
					bottom: "calc(100% + 6px)",
					right: 0,
					whiteSpace: "nowrap",
					fontSize: 11,
					lineHeight: "16px",
					padding: "2px 7px",
					borderRadius: 6,
					color: "#ffd0d0",
					background: "rgba(20,22,28,.92)",
					border: "1px solid rgba(255,255,255,.09)",
					pointerEvents: "none",
					maxWidth: 320,
					overflow: "hidden",
					textOverflow: "ellipsis",
					zIndex: 5
				}
			}, msg) : null;
		}

		function micIcon(slashed) {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true"
			},
				h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
				h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
				h("path", { d: "M12 18v3" }),
				slashed ? h("path", { d: "M3 3l18 18" }) : null
			);
		}

		function roundButton(extra) {
			return Object.assign({
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 28,
				height: 28,
				padding: 0,
				border: "none",
				borderRadius: 999,
				cursor: "pointer",
				transition: "background .15s, box-shadow .15s"
			}, extra || {});
		}

		// ── the mic button: dictate, then you press Send ────────────────────
		// In voice mode it becomes the MUTE button for voice mode's mic.

		function DictationButton() {
			var bus = useVoiceBus();
			var recording = useState(false);
			var isRec = recording[0];
			var setRec = recording[1];
			var pendingState = useState(0);
			var pending = pendingState[0];
			var status = useFadingMessage();
			var msg = status[0];
			var setMsg = status[1];
			var ctlRef = useRef(null);

			useEffect(warmOnce, []);
			useEffect(function () { return function () { if (ctlRef.current) ctlRef.current.stop(); }; }, []);
			// Entering voice mode ends a dictation in progress: one mic at a time.
			useEffect(function () { if (bus.mode && ctlRef.current) ctlRef.current.stop(); }, [bus.mode]);

			var unsupported = !canRecord();
			var keepFocus = function (e) { e.preventDefault(); };

			if (bus.mode) {
				var muted = bus.muted;
				return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
					h("button", {
						type: "button",
						onMouseDown: keepFocus,
						onClick: function () { if (bus.setMuted) bus.setMuted(!muted); },
						title: muted ? "Mic muted — voice mode stays on. Click to unmute." : "Mute the mic (voice mode stays on)",
						"aria-label": muted ? "Unmute microphone" : "Mute microphone",
						"aria-pressed": muted ? "true" : "false",
						"data-voice-mute": muted ? "muted" : "live",
						style: roundButton({
							color: muted ? "#ffffff" : "#e6e9ef",
							background: muted ? "#5b616e" : "rgba(255,255,255,.08)"
						})
					}, micIcon(muted)),
					hintBubble(msg));
			}

			var toggle = function () {
				if (ctlRef.current) { ctlRef.current.stop(); return; }
				ctlRef.current = startDictation({
					onListening: setRec,
					onPending: pendingState[1],
					onError: setMsg,
					onEnd: function () { ctlRef.current = null; pendingState[1](0); }
				}, { autoStopMs: 5000 });
			};
			var working = !isRec && pending > 0;

			return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
				h("button", {
					type: "button",
					// Keep focus (and the caret) in the message box when the mic is clicked.
					onMouseDown: keepFocus,
					onClick: unsupported ? undefined : toggle,
					disabled: unsupported,
					title: unsupported
						? "Recording is not available in this browser"
						: (isRec ? "Listening — pause 5 s or click to stop" : "Dictate (transcribed locally)"),
					"aria-label": isRec ? "Stop dictating" : "Start dictating",
					"aria-pressed": isRec ? "true" : "false",
					style: roundButton({
						cursor: unsupported ? "default" : "pointer",
						color: isRec ? "#ffffff" : (working ? "#ffc46b" : "#8a93a3"),
						background: isRec ? "#e5484d" : "transparent",
						boxShadow: isRec ? "0 0 0 3px rgba(229,72,77,.28)" : (working ? "0 0 0 2px rgba(255,196,107,.45)" : "none"),
						opacity: unsupported ? 0.4 : 1
					})
				}, micIcon(false)),
				hintBubble(msg));
		}

		// ── voice mode: hands-free conversation ─────────────────────────────
		/**
		 * The round button on the far right of the input bar, like ChatGPT's.
		 * While the message box is empty it stands where Send is (the harness's
		 * Send button is hidden while disabled); once there is text it steps
		 * aside, unless voice mode is on.
		 *
		 * Tap it and it turns RED and stays red -- the mic stays open -- until
		 * you tap it again. Talk; when you go quiet for CONVO_SEND_AFTER_MS, what you said is
		 * sent with Ctrl+Enter, the harness's own gesture: a new message when
		 * the agent is idle, a STEER when it is busy. So you can talk while it
		 * works or reads to you, and your words redirect it.
		 *
		 * Replies are read aloud automatically (dsh-plugin-speech). While one
		 * is being read:
		 *   - anything the mic picks up that matches the words being read is
		 *     dropped (the mic hearing the speaker must never steer the agent);
		 *   - real words of your own interrupt the reading, like ChatGPT.
		 * The mic button becomes a mute button for as long as voice mode is on.
		 */
		var CONVO_SEND_AFTER_MS = 2000;   // quiet that sends what you said (2 s; raise it if it sends mid-thought)
		var SEND_LABELS = ["Send message", "发送消息"];
		var ECHO_GRACE_MS = 1500;         // the speaker's tail after reading stops

		function findSendButton() {
			for (var i = 0; i < SEND_LABELS.length; i++) {
				var b = document.querySelector('button[aria-label="' + SEND_LABELS[i] + '"]');
				if (b) return b;
			}
			return null;
		}

		/**
		 * Send what is in the box: Ctrl+Enter on the composer, which the harness
		 * resolves to a normal send when the agent is idle and to a steer when it
		 * is busy. Falls back to the Send button if the box did not clear.
		 */
		function submitComposer() {
			return new Promise(function (resolve) {
				var el = findComposer();
				if (!el) { resolve(false); return; }
				var before = composerText(el);
				el.dispatchEvent(new KeyboardEvent("keydown", {
					key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true
				}));
				setTimeout(function () {
					var now = findComposer();
					if (!now || composerText(now) !== before || !composerText(now).trim()) { resolve(true); return; }
					var b = findSendButton();
					if (b && !b.disabled) { b.click(); resolve(true); return; }
					resolve(false);
				}, 400);
			});
		}

		var styleInjected = false;
		function injectComposerStyle() {
			if (styleInjected) return;
			styleInjected = true;
			var css = SEND_LABELS.map(function (l) { return 'button[aria-label="' + l + '"]:disabled'; }).join(",")
				+ "{display:none!important}"
				+ "@keyframes dshVoicePulse{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}70%{box-shadow:0 0 0 9px rgba(229,72,77,0)}100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}}";
			var tag = document.createElement("style");
			tag.setAttribute("data-plugin", "dsh-plugin-dictation");
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function composerEmpty() {
			var el = findComposer();
			return !el || !composerText(el).trim();
		}

		/** Words, lower-cased, no punctuation. */
		function wordsOf(s) {
			return String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
		}

		/**
		 * Is `text` the mic hearing the reply being read? True when most of its
		 * words occur in what is being read. Short fragments count as echo too:
		 * one or two words during a reading are too ambiguous to act on.
		 */
		function looksLikeEcho(text, reading) {
			var w = wordsOf(text);
			if (!w.length) return true;
			var pool = new Set(wordsOf(reading));
			var hits = w.filter(function (x) { return pool.has(x); }).length;
			return w.length <= 2 || hits / w.length >= 0.6;
		}

		function VoiceModeButton() {
			var bus = useVoiceBus();
			var emptyState = useState(composerEmpty());
			var empty = emptyState[0];
			var status = useFadingMessage();
			var msg = status[0];
			var setMsg = status[1];
			var ctlRef = useRef(null);
			var rootRef = useRef(null);
			var readingEndedAt = useRef(0);

			useEffect(function () { injectComposerStyle(); warmOnce(); }, []);

			// Sit at the far right of the input bar, where Send is.
			useEffect(function () {
				var el = rootRef.current;
				var send = findSendButton();
				if (!el || !send) return;
				var node = el;
				while (node.parentElement && !node.parentElement.contains(send)) node = node.parentElement;
				if (node.parentElement) node.style.order = "99";
			});

			// Track whether the box is empty (that decides who owns the spot).
			useEffect(function () {
				var check = function () { emptyState[1](composerEmpty()); };
				document.addEventListener("input", check, true);
				var t = setInterval(check, 400);
				return function () { document.removeEventListener("input", check, true); clearInterval(t); };
			}, []);

			// Remember when reading ended: the speaker's tail can still reach the mic.
			useEffect(function () {
				return bus.on(function (type) { if (type === "spoken") readingEndedAt.current = Date.now(); });
			}, []);

			var leave = useCallback(function () {
				bus.mode = false;
				bus.muted = false;
				bus.awaitingReply = false;
				bus.setMuted = null;
				if (ctlRef.current) { var c = ctlRef.current; ctlRef.current = null; c.stop(); }
				bus.emit("stop-speaking");
				bus.emit("mode");
			}, []);

			var enter = useCallback(function () {
				bus.mode = true;
				bus.muted = false;
				bus.awaitingReply = false;
				ctlRef.current = startDictation({
					onListening: function () {},
					onError: function (m) { setMsg(m); },
					onEnd: function () { if (bus.mode) leave(); },   // the mic went away
					filter: function (text, final) {
						var reading = bus.speaking || Date.now() - readingEndedAt.current < ECHO_GRACE_MS;
						if (!reading) return text;
						if (looksLikeEcho(text, bus.speakingText)) return "";
						// Real words over the reading: interrupt it, like ChatGPT.
						if (bus.speaking) bus.emit("stop-speaking");
						return text;
					},
					onUtterance: function () {
						// The next finished reply is read aloud; mark it before sending.
						bus.awaitingReply = true;
						submitComposer().then(function (ok) {
							if (!ok) { bus.awaitingReply = false; setMsg("Could not send — press Enter"); }
						});
					}
				}, { continuous: true, sendAfterMs: CONVO_SEND_AFTER_MS });
				bus.setMuted = function (m) {
					bus.muted = !!m;
					if (ctlRef.current) ctlRef.current.setMuted(bus.muted);
					bus.emit("mute");
				};
				bus.emit("mode");
			}, [leave]);

			useEffect(function () { return function () { if (bus.mode) leave(); }; }, [leave]);

			var on = bus.mode;
			if (!on && !empty) return h("span", { ref: rootRef, style: { display: "none" } });

			var muted = on && bus.muted;
			var bars = [4, 9, 13, 9, 4];
			var button = h("button", {
				type: "button",
				onMouseDown: function (e) { e.preventDefault(); },
				onClick: function () { if (bus.mode) leave(); else enter(); },
				title: !on ? "Voice mode — talk hands-free; replies are read aloud"
					: muted ? "Voice mode on, mic muted — tap to leave voice mode"
					: "Voice mode on: talk any time (a 2 s pause sends; talking while it works steers it). Tap to leave.",
				"aria-label": on ? "Leave voice mode" : "Start voice mode",
				"aria-pressed": on ? "true" : "false",
				"data-voice-phase": !on ? "off" : muted ? "muted" : "on",
				style: roundButton({
					width: 32,
					height: 32,
					color: on ? "#ffffff" : "#111418",
					background: on ? (muted ? "#8e3a3d" : "#e5484d") : "#f2f4f7",
					animation: on && !muted && bus.speaking ? "dshVoicePulse 1.4s infinite" : "none"
				})
			},
				h("svg", { width: 16, height: 16, viewBox: "0 0 20 20", "aria-hidden": "true" },
					bars.map(function (hgt, i) {
						return h("rect", { key: i, x: 1.5 + i * 3.8, y: 10 - hgt / 2, width: 2.2, height: hgt, rx: 1.1, fill: "currentColor" });
					})
				)
			);

			return h("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4 } }, button, hintBubble(msg));
		}

		/** Required service: the UI slot registry. */
		var inject = ["slots"];

		/**
		 * Mount the mic (dictate) and the voice-mode button in the input bar.
		 *
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", function () {
				var offMic = ctx.slots.register({
					name: "conversation.input.right",
					id: "dictation",
					order: 50
				}, DictationButton);
				var offVoice = ctx.slots.register({
					name: "conversation.input.right",
					id: "voice-mode",
					order: 99
				}, VoiceModeButton);
				return function () { offMic(); offVoice(); };
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
