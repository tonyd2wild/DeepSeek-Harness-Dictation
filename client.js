/**
 * dsh-plugin-dictation — BROWSER half.
 *
 * Served at /plugins/dsh-plugin-dictation/client.js by the host's client-modules
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
 *   the same page, the same code, which is exactly the symptom reported.
 *
 *   So this version takes Google out of the path entirely:
 *     getUserMedia -> MediaRecorder (webm/opus) -> POST to
 *     /api/dictation/transcribe -> local openai-whisper -> text into composer.
 *
 *   Nothing leaves the machine, no API key is involved, and it behaves
 *   identically in the Electron shell, in Chrome, and fully offline.
 *
 * CLICK TO RECORD, CLICK AGAIN TO TRANSCRIBE
 *   Continuous streaming would need chunked uploads and mid-sentence stitching.
 *   For dictation, click-to-stop is honest about what it does and can never
 *   mis-splice two phrases.
 *
 * INSERTION IS LAYERED, ON PURPOSE
 *   Writing into another package's composer is the fragile part. Three
 *   strategies are tried in order and the first that reports success wins:
 *     1. The session event bus: "slash/input-insert-text".
 *     2. Focus the composer and use document.execCommand("insertText").
 *     3. Native value setter + a dispatched "input" event on the contenteditable.
 *   A status line reports which path ran, so a failure is visible, not silent.
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

		// ── the button ───────────────────────────────────────────────────────
		/**
		 * Push-to-dictate control for the composer's right-hand cluster.
		 *
		 * Click to record, click again to stop and transcribe.
		 */
		function DictationButton(props) {
			var kit = props || {};
			var sessionEvents = kit.events || kit.sessionEvents || null;

			var recording = useState(false);
			var isRec = recording[0];
			var setRec = recording[1];

			var busy = useState(false);
			var isBusy = busy[0];
			var setBusy = busy[1];

			var status = useState(null);
			var msg = status[0];
			var setMsg = status[1];
			// A finished hint ("Inserted via …", "Heard nothing", an error) used to
			// stay on screen until the next dictation -- nothing ever cleared it.
			// In-progress hints stay; anything else fades after a few seconds.
			useEffect(function () {
				if (!msg || /^(Recording|Waiting|Transcribing)/.test(msg)) return;
				var t = setTimeout(function () { setMsg(null); }, 4000);
				return function () { clearTimeout(t); };
			}, [msg]);

			var streamRef = useRef(null);
			var recorderRef = useRef(null);
			var chunksRef = useRef([]);
			var startedRef = useRef(0);
			var levelTimerRef = useRef(null);
			var peakRef = useRef(0);

			/** Release the microphone. Track-based, so the OS indicator clears. */
			var releaseMic = useCallback(function () {
				try {
					if (streamRef.current) {
						var tracks = streamRef.current.getTracks();
						for (var i = 0; i < tracks.length; i++) tracks[i].stop();
					}
				} catch (e) { /* already released */ }
				streamRef.current = null;
			}, []);

			/** Stop recording; the recorder's onstop uploads and inserts. */
			var finish = useCallback(function () {
				var rec = recorderRef.current;
				if (!rec) return;
				try { rec.stop(); } catch (e) { /* already stopped */ }
			}, []);

			/** Start recording. */
			var begin = useCallback(function () {
				if (!canRecord()) {
					setMsg("This browser cannot record audio");
					return;
				}
				setMsg("Waiting for the microphone…");

				navigator.mediaDevices.getUserMedia({
					audio: {
						// Dictation, not music: speech-tuned processing helps a lot
						// and whisper copes with it fine.
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true
					}
				}).then(function (stream) {
					streamRef.current = stream;
					chunksRef.current = [];
					var mime = pickMimeType();
					var rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
					recorderRef.current = rec;
					startedRef.current = Date.now();

					// ── live level meter ─────────────────────────────────────────
					// This exists to make the failure VISIBLE. If the mic is
					// delivering silence, a peak of 0.000 during recording says so
					// immediately, instead of leaving us to infer it from a
					// hallucinated transcript after the fact.
					var audioCtx = null;
					var peak = 0;
					try {
						var AC = window.AudioContext || window.webkitAudioContext;
						if (AC) {
							audioCtx = new AC();
							var src = audioCtx.createMediaStreamSource(stream);
							var analyser = audioCtx.createAnalyser();
							analyser.fftSize = 512;
							src.connect(analyser);
							var buf = new Float32Array(analyser.fftSize);
							levelTimerRef.current = setInterval(function () {
								try {
									analyser.getFloatTimeDomainData(buf);
									var local = 0;
									for (var i = 0; i < buf.length; i++) {
										var v = Math.abs(buf[i]);
										if (v > local) local = v;
									}
									if (local > peak) peak = local;
									peakRef.current = peak;
									// A moving label, so the human can SEE it hearing them.
									setMsg("Recording… level " + peak.toFixed(2)
										+ (peak < 0.01 ? " (silent!)" : ""));
								} catch (e) { /* meter is best-effort */ }
							}, 250);
						}
					} catch (e) { /* no meter; recording still works */ }

					rec.ondataavailable = function (ev) {
						if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
					};

					rec.onstop = function () {
						releaseMic();
						if (levelTimerRef.current) {
							clearInterval(levelTimerRef.current);
							levelTimerRef.current = null;
						}
						var elapsed = (Date.now() - startedRef.current) / 1000;
						var heardPeak = peakRef.current;
						var blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
						recorderRef.current = null;
						chunksRef.current = [];
						setRec(false);

						if (blob.size === 0 || elapsed < 0.6) {
							setMsg("Too short — hold on a moment longer");
							return;
						}

						setBusy(true);
						setMsg("Transcribing " + elapsed.toFixed(1) + "s locally…");
						transcribe(blob).then(function (body) {
							var text = (body.text || "").trim();
							if (!text) { setMsg("Heard nothing — try again"); return; }

							// Whisper hallucinates short common words on empty or
							// near-empty audio; "You" and "Thank you." are the
							// classic pair. Verified 2026-09-18: 0.5s of pure
							// silence transcribes to exactly "You". If we get one
							// of those from a very short recording, it is far more
							// likely to be a silent capture than real speech, so
							// say so instead of inserting a mystery word.
							var HALLUCINATIONS = ["you", "thank you", "thank you.", "you."];
							var suspect = elapsed < 2.5
								&& HALLUCINATIONS.indexOf(text.toLowerCase()) >= 0;
							if (suspect) {
								setMsg("Heard nothing — is the mic picking you up?");
								return;
							}

							var how = insertTranscript(sessionEvents, text);
							// The peak is the honest signal: if the mic heard
							// nothing, say so even when whisper invented a word.
							var quiet = heardPeak < 0.01;
							setMsg(how
								? ("Inserted via " + how + (quiet ? " (mic level was very low)" : ""))
								: "Could not reach the composer");
						}).catch(function (e) {
							setMsg("Transcription failed: " + (e && e.message ? e.message : e));
						}).then(function () { setBusy(false); });
					};

					rec.start(1000);   // timeslice: flush every second
					setRec(true);
					setMsg("Recording… click again to stop");
				}).catch(function (e) {
					var name = e && e.name;
					if (name === "NotAllowedError" || name === "SecurityError") {
						setMsg("Microphone blocked — allow it for this app");
					} else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
						setMsg("No microphone found");
					} else {
						setMsg("Microphone error: " + (name || e));
					}
					releaseMic();
					setRec(false);
				});
			}, [sessionEvents, releaseMic]);

			var toggle = useCallback(function () {
				if (isBusy) return;
				if (isRec) finish(); else begin();
			}, [isBusy, isRec, begin, finish]);

			// Release the mic if the button unmounts (session switch), so a hidden
			// button can never hold the microphone open.
			useEffect(function () {
				return function () {
					if (levelTimerRef.current) {
						clearInterval(levelTimerRef.current);
						levelTimerRef.current = null;
					}
					try { if (recorderRef.current) recorderRef.current.stop(); } catch (e) { /* fine */ }
					releaseMic();
				};
			}, [releaseMic]);

			var unsupported = !canRecord();
			var tone = isRec ? "#ff6b6b" : (isBusy ? "#ffc46b" : "#8a93a3");

			var button = h("button", {
				type: "button",
				onClick: unsupported ? undefined : toggle,
				disabled: unsupported,
				title: unsupported
					? "Recording is not available in this browser"
					: (isRec ? "Stop and transcribe" : "Dictate (recorded locally)"),
				"aria-label": isRec ? "Stop and transcribe" : "Start dictating",
				"aria-pressed": isRec ? "true" : "false",
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 28,
					height: 28,
					padding: 0,
					border: "none",
					borderRadius: 999,
					cursor: unsupported ? "default" : "pointer",
					opacity: unsupported ? 0.45 : 1,
					color: tone,
					background: isRec ? "rgba(255,107,107,.14)" : "transparent",
					transition: "background .15s ease, color .15s ease",
					boxShadow: isRec ? "0 0 8px rgba(255,107,107,.55)" : "none"
				}
			},
				h("svg", {
					width: 15, height: 15, viewBox: "0 0 24 24",
					fill: "none", stroke: "currentColor",
					strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round",
					"aria-hidden": "true"
				},
					h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
					h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
					h("path", { d: "M12 18v3" })
				)
			);

			// Absolutely positioned, so the hint cannot disturb composer layout.
			var wrap = h("span", {
				style: { position: "relative", display: "inline-flex", alignItems: "center" }
			},
				button,
				msg && h("span", {
					style: {
						position: "absolute",
						bottom: "calc(100% + 6px)",
						right: 0,
						whiteSpace: "nowrap",
						fontSize: 11,
						lineHeight: "16px",
						padding: "2px 7px",
						borderRadius: 6,
						color: isRec ? "#ffd0d0" : "#b8c0cc",
						background: "rgba(20,22,28,.92)",
						border: "1px solid rgba(255,255,255,.09)",
						pointerEvents: "none",
						maxWidth: 300,
						overflow: "hidden",
						textOverflow: "ellipsis"
					}
				}, msg)
			);

			return wrap;
		}

		/** Required service: the UI slot registry. */
		var inject = ["slots"];

		/**
		 * Mount the dictation control beside the composer's send controls.
		 *
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", function () {
				return ctx.slots.register({
					name: "conversation.input.right",
					id: "dictation",
					order: 50
				}, DictationButton);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
