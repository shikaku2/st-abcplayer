/**
 * ABC Music Player — SillyTavern Extension
 * Renders ```abc code blocks as interactive sheet music with playback + download.
 *
 * Dependencies: abcjs (loaded from CDN at runtime)
 * Author: Shikaku2
 */

import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXT_NAME = 'abc-music-player';
const ABCJS_CDN = 'https://cdn.jsdelivr.net/npm/abcjs@6.4.4/dist/abcjs-basic-min.js';
const LAMEJS_CDN = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

// Full GM soundfont — required for non-piano instruments (sax, trumpet, bass, etc.)
// paulrosen's abcjs-specific URL is piano-only; FluidR3_GM has all 128 GM instruments.
// Per-note MP3s, ~80KB each, browser-cached after first fetch.
const SOUNDFONT_URL = 'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/';

// -------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------

const defaultSettings = {
    enabled: true,
    autoRender: true,
    showNotation: true,
    tempoMultiplier: 1.0,
    mp3BitrateKbps: 256,
};

function loadSettings() {
    extension_settings[EXT_NAME] = Object.assign({}, defaultSettings, extension_settings[EXT_NAME]);
}

// -------------------------------------------------------------------
// abcjs loader (CDN, once)
// -------------------------------------------------------------------

let _abcjsPromise = null;

async function loadAbcjs() {
    if (window.ABCJS) return window.ABCJS;
    if (_abcjsPromise) return _abcjsPromise;

    _abcjsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ABCJS_CDN;
        script.onload = () => {
            if (window.ABCJS) resolve(window.ABCJS);
            else reject(new Error('abcjs loaded but window.ABCJS not found'));
        };
        script.onerror = () => reject(new Error(`Failed to load abcjs from ${ABCJS_CDN}`));
        document.head.appendChild(script);
    });

    return _abcjsPromise;
}

let _lamejsPromise = null;

async function loadLamejs() {
    if (window.lamejs) return window.lamejs;
    if (_lamejsPromise) return _lamejsPromise;

    _lamejsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LAMEJS_CDN;
        script.onload = () => {
            if (window.lamejs) resolve(window.lamejs);
            else reject(new Error('lamejs loaded but window.lamejs not found'));
        };
        script.onerror = () => reject(new Error(`Failed to load lamejs from ${LAMEJS_CDN}`));
        document.head.appendChild(script);
    });

    return _lamejsPromise;
}

// -------------------------------------------------------------------
// MP3 encoding helper
// -------------------------------------------------------------------

/**
 * Encode an AudioBuffer to an MP3 Blob using lamejs (CBR).
 */
function audioBufferToMp3Blob(buffer, kbps) {
    const numChannels = Math.min(buffer.numberOfChannels, 2);
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;

    // Convert Float32 [-1, 1] to Int16 PCM
    const left = new Int16Array(length);
    const right = numChannels > 1 ? new Int16Array(length) : null;
    const leftF = buffer.getChannelData(0);
    const rightF = numChannels > 1 ? buffer.getChannelData(1) : null;
    for (let i = 0; i < length; i++) {
        const l = Math.max(-1, Math.min(1, leftF[i]));
        left[i] = l < 0 ? l * 0x8000 : l * 0x7FFF;
        if (right) {
            const r = Math.max(-1, Math.min(1, rightF[i]));
            right[i] = r < 0 ? r * 0x8000 : r * 0x7FFF;
        }
    }

    const encoder = new window.lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
    const chunks = [];
    const blockSize = 1152; // MP3 frame size
    for (let i = 0; i < length; i += blockSize) {
        const leftChunk = left.subarray(i, i + blockSize);
        const mp3buf = right
            ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
            : encoder.encodeBuffer(leftChunk);
        if (mp3buf.length > 0) chunks.push(mp3buf);
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(tail);

    return new Blob(chunks, { type: 'audio/mp3' });
}

// -------------------------------------------------------------------
// WAV encoding helper
// -------------------------------------------------------------------

/**
 * Encode an AudioBuffer to a WAV Blob (16-bit stereo PCM).
 */
function audioBufferToWavBlob(buffer) {
    const numChannels = Math.min(buffer.numberOfChannels, 2);
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);

    function writeStr(offset, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);           // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return new Blob([ab], { type: 'audio/wav' });
}

/**
 * Trigger a browser file download.
 */
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// -------------------------------------------------------------------
// Duration estimation for OfflineAudioContext
// -------------------------------------------------------------------

/**
 * Rough duration estimate in seconds from an abcjs visualObj.
 * Uses millisecondsPerMeasure × barline count from the raw ABC string.
 * Adds 3s tail to avoid clipping reverb/decay.
 */
function estimateDurationSeconds(abcString, visualObj) {
    const msPerMeasure = visualObj.millisecondsPerMeasure() || 2000;
    // Count standalone barlines (not part of ||, |: :|, etc.)
    const barlines = (abcString.match(/\|(?![|\]:])/g) || []).length;
    const measures = Math.max(barlines, 2);
    return Math.ceil((measures * msPerMeasure) / 1000) + 4;
}

// -------------------------------------------------------------------
// Per-block player state tracker (keyed by wrapper element)
// -------------------------------------------------------------------

// Map<HTMLElement, { synth, audioCtx, playing }>
const playerState = new WeakMap();

// -------------------------------------------------------------------
// Build player widget for one ABC block
// -------------------------------------------------------------------

async function buildPlayerWidget(abcString, messageId, blockIndex) {
    const ABCJS = await loadAbcjs();
    const settings = extension_settings[EXT_NAME];

    const wrapperId = `abc-player-${messageId}-${blockIndex}`;
    const notationId = `abc-notation-${messageId}-${blockIndex}`;

    // --- Parse title from ABC header ---
    const titleMatch = abcString.match(/^T:(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Composition';

    // --- Build HTML skeleton ---
    const wrapper = document.createElement('div');
    wrapper.className = 'abc-player-wrapper';
    wrapper.id = wrapperId;
    wrapper.innerHTML = `
        <div class="abc-player-title">
            <i class="fa-solid fa-music"></i>
            <span>${DOMPurify.sanitize(title)}</span>
        </div>
        <div class="abc-notation-container${settings.showNotation ? '' : ' hidden'}" id="${notationId}"></div>
        <div class="abc-render-progress"><div class="abc-render-progress-bar"></div></div>
        <div class="abc-player-controls">
            <button class="abc-btn-play" title="Play">
                <i class="fa-solid fa-play"></i> Play
            </button>
            <button class="abc-btn-stop" title="Stop" disabled>
                <i class="fa-solid fa-stop"></i> Stop
            </button>
            <button class="abc-btn-toggle-notation" title="Toggle sheet music">
                <i class="fa-solid fa-sheet-plastic"></i> ${settings.showNotation ? 'Hide' : 'Show'} notation
            </button>
            <div class="abc-download-group">
                <button class="abc-btn-dl-midi" title="Download MIDI">
                    <i class="fa-solid fa-download"></i> MIDI
                </button>
                <button class="abc-btn-dl-wav" title="Download WAV (renders offline)">
                    <i class="fa-solid fa-download"></i> WAV
                </button>
                <button class="abc-btn-dl-mp3" title="Download MP3">
                    <i class="fa-solid fa-download"></i> MP3
                </button>
            </div>
        </div>
        <div class="abc-player-status"></div>
    `;

    const notationContainer = wrapper.querySelector(`#${notationId}`);
    const btnPlay = wrapper.querySelector('.abc-btn-play');
    const btnStop = wrapper.querySelector('.abc-btn-stop');
    const btnToggle = wrapper.querySelector('.abc-btn-toggle-notation');
    const btnDlMidi = wrapper.querySelector('.abc-btn-dl-midi');
    const btnDlWav = wrapper.querySelector('.abc-btn-dl-wav');
    const btnDlMp3 = wrapper.querySelector('.abc-btn-dl-mp3');
    const statusEl = wrapper.querySelector('.abc-player-status');
    const progressBar = wrapper.querySelector('.abc-render-progress');
    const progressFill = wrapper.querySelector('.abc-render-progress-bar');

    function setStatus(msg, isError = false) {
        statusEl.textContent = msg;
        statusEl.className = 'abc-player-status' + (isError ? ' error' : '');
    }

    // --- Render sheet music ---
    let visualObj = null;
    try {
        const renderOpts = {
            responsive: 'resize',
            add_classes: true,
            selectTypes: false,
        };
        const result = ABCJS.renderAbc(notationContainer, abcString, renderOpts);
        visualObj = result[0];
        if (!visualObj) throw new Error('abcjs returned no visual object');
    } catch (err) {
        setStatus(`Render error: ${err.message}`, true);
        btnPlay.disabled = true;
        btnDlMidi.disabled = true;
        btnDlWav.disabled = true;
        btnDlMp3.disabled = true;
        return wrapper;
    }

    // --- Play / Stop ---
    let audioCtx = null;
    let activeSynth = null;
    let isPlaying = false;

    async function stopPlayback() {
        if (activeSynth) {
            try { activeSynth.stop(); } catch (_) {}
            activeSynth = null;
        }
        if (audioCtx) {
            try { await audioCtx.close(); } catch (_) {}
            audioCtx = null;
        }
        isPlaying = false;
        btnPlay.disabled = false;
        btnStop.disabled = true;
        btnPlay.innerHTML = '<i class="fa-solid fa-play"></i> Play';
        setStatus('');
    }

    async function startPlayback() {
        if (isPlaying) await stopPlayback();

        btnPlay.disabled = true;
        btnStop.disabled = false;
        btnPlay.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…';
        setStatus('Loading soundfont…');

        try {
            audioCtx = new AudioContext();
            const synth = new ABCJS.synth.CreateSynth();
            activeSynth = synth;

            const tempoMultiplier = extension_settings[EXT_NAME].tempoMultiplier ?? 1.0;
            const msPerMeasure = visualObj.millisecondsPerMeasure() / tempoMultiplier;

            await synth.init({
                visualObj,
                audioContext: audioCtx,
                millisecondsPerMeasure: msPerMeasure,
                options: {
                    soundFontUrl: SOUNDFONT_URL,
                    onEnded: () => stopPlayback(),
                },
            });

            await synth.prime();
            isPlaying = true;
            btnPlay.innerHTML = '<i class="fa-solid fa-play"></i> Playing…';
            btnPlay.disabled = true;
            setStatus('');
            synth.start();

        } catch (err) {
            setStatus(`Playback error: ${err.message}`, true);
            await stopPlayback();
        }
    }

    btnPlay.addEventListener('click', startPlayback);
    btnStop.addEventListener('click', stopPlayback);

    // --- Toggle notation ---
    btnToggle.addEventListener('click', () => {
        notationContainer.classList.toggle('hidden');
        const visible = !notationContainer.classList.contains('hidden');
        btnToggle.innerHTML = `<i class="fa-solid fa-sheet-plastic"></i> ${visible ? 'Hide' : 'Show'} notation`;
    });

    // --- MIDI Download ---
    btnDlMidi.addEventListener('click', () => {
        try {
            const midiData = ABCJS.synth.getMidiFile(abcString, {
                midiOutputType: 'encoded',
                millisecondsPerMeasure: visualObj.millisecondsPerMeasure(),
            });
            // midiData is a base64 data URI: "data:audio/midi;base64,..."
            fetch(midiData)
                .then(r => r.blob())
                .then(blob => triggerDownload(blob, `${sanitizeFilename(title)}.mid`))
                .catch(err => setStatus(`MIDI export error: ${err.message}`, true));
        } catch (err) {
            setStatus(`MIDI export error: ${err.message}`, true);
        }
    });

    // --- Render audio buffer (shared by WAV and MP3 download) ---
    // abcjs's prime() renders the entire song into an internal AudioBuffer using
    // per-note OfflineAudioContexts (see place-note.js). We grab that buffer via
    // getAudioBuffer() and encode it ourselves — no outer OfflineAudioContext needed.
    async function renderToAudioBuffer() {
        const renderCtx = new AudioContext();
        try {
            const tempoMultiplier = extension_settings[EXT_NAME].tempoMultiplier ?? 1.0;
            const msPerMeasure = visualObj.millisecondsPerMeasure() / tempoMultiplier;

            const renderSynth = new ABCJS.synth.CreateSynth();
            await renderSynth.init({
                visualObj,
                audioContext: renderCtx,
                millisecondsPerMeasure: msPerMeasure,
                options: { soundFontUrl: SOUNDFONT_URL },
            });
            await renderSynth.prime();

            const audioBuffer = renderSynth.getAudioBuffer();
            if (!audioBuffer) throw new Error('No audio buffer produced');
            return audioBuffer;
        } finally {
            try { await renderCtx.close(); } catch (_) {}
        }
    }

    async function runExport({ label, encode, ext }) {
        btnDlWav.disabled = true;
        btnDlMp3.disabled = true;
        btnDlMidi.disabled = true;
        const prevStatus = statusEl.textContent;

        setStatus(`Rendering audio for ${label}…`);
        progressBar.classList.add('active');
        progressFill.style.width = '20%';

        try {
            const audioBuffer = await renderToAudioBuffer();
            progressFill.style.width = '70%';

            setStatus(`Encoding ${label}…`);
            const blob = await encode(audioBuffer);
            progressFill.style.width = '95%';

            triggerDownload(blob, `${sanitizeFilename(title)}.${ext}`);
            progressFill.style.width = '100%';
            setStatus(`${label} downloaded.`);
            setTimeout(() => {
                progressBar.classList.remove('active');
                progressFill.style.width = '0%';
                setStatus(prevStatus);
            }, 2000);
        } catch (err) {
            progressBar.classList.remove('active');
            progressFill.style.width = '0%';
            setStatus(`${label} export error: ${err.message}`, true);
        } finally {
            btnDlWav.disabled = false;
            btnDlMp3.disabled = false;
            btnDlMidi.disabled = false;
        }
    }

    btnDlWav.addEventListener('click', () => runExport({
        label: 'WAV',
        ext: 'wav',
        encode: (buf) => audioBufferToWavBlob(buf),
    }));

    btnDlMp3.addEventListener('click', () => runExport({
        label: 'MP3',
        ext: 'mp3',
        encode: async (buf) => {
            await loadLamejs();
            return audioBufferToMp3Blob(buf, extension_settings[EXT_NAME].mp3BitrateKbps ?? 256);
        },
    }));

    playerState.set(wrapper, { visualObj, title });
    return wrapper;
}

// -------------------------------------------------------------------
// Filename sanitizer
// -------------------------------------------------------------------

function sanitizeFilename(name) {
    return (name || 'music').replace(/[^a-z0-9_\-\s]/gi, '').replace(/\s+/g, '_').slice(0, 64) || 'music';
}

// -------------------------------------------------------------------
// Message processing: find ```abc blocks, inject player widgets
// -------------------------------------------------------------------

async function processMessage(messageId) {
    const settings = extension_settings[EXT_NAME];
    if (!settings.enabled) return;

    // Find the rendered message in the DOM
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!msgEl) return;

    // Only process character (AI) messages
    const msgData = getContext().chat[messageId];
    if (!msgData || msgData.is_user) return;

    // Find all ```abc code blocks that haven't been processed yet
    // ST's hljs integration prefixes language classes with "custom-"
    const codeBlocks = msgEl.querySelectorAll('pre code.custom-language-abc:not([data-abc-processed])');
    if (!codeBlocks.length) return;

    for (let i = 0; i < codeBlocks.length; i++) {
        const codeEl = codeBlocks[i];
        const abcString = codeEl.textContent.trim();
        if (!abcString) continue;

        codeEl.setAttribute('data-abc-processed', '1');

        try {
            const widget = await buildPlayerWidget(abcString, messageId, i);
            // Replace the <pre> block (parent of <code>) with the widget
            const preEl = codeEl.closest('pre');
            if (preEl) {
                preEl.replaceWith(widget);
            } else {
                codeEl.closest('.mes_text').appendChild(widget);
            }
        } catch (err) {
            console.error(`[${EXT_NAME}] Failed to build widget for message ${messageId} block ${i}:`, err);
        }
    }
}

// -------------------------------------------------------------------
// Settings UI
// -------------------------------------------------------------------

async function addSettingsUI() {
    const html = await renderExtensionTemplateAsync('third-party/st-abcplayer', 'settings');
    $('#extensions_settings').append(html);

    const settings = extension_settings[EXT_NAME];

    $('#abc_player_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            extension_settings[EXT_NAME].enabled = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#abc_player_autorender')
        .prop('checked', settings.autoRender)
        .on('change', function () {
            extension_settings[EXT_NAME].autoRender = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#abc_player_show_notation')
        .prop('checked', settings.showNotation)
        .on('change', function () {
            extension_settings[EXT_NAME].showNotation = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#abc_player_tempo')
        .val(settings.tempoMultiplier)
        .on('change', function () {
            const val = parseFloat($(this).val());
            if (!isNaN(val) && val > 0) {
                extension_settings[EXT_NAME].tempoMultiplier = val;
                saveSettingsDebounced();
            }
        });

    $('#abc_player_mp3_bitrate')
        .val(settings.mp3BitrateKbps)
        .on('change', function () {
            const val = parseInt($(this).val(), 10);
            if (!isNaN(val)) {
                extension_settings[EXT_NAME].mp3BitrateKbps = val;
                saveSettingsDebounced();
            }
        });
}

// -------------------------------------------------------------------
// Events
// -------------------------------------------------------------------

function registerEvents() {
    // Primary hook: fires after a message's DOM is fully rendered
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        if (!extension_settings[EXT_NAME].autoRender) return;
        await processMessage(messageId);
    });

    // Also re-process on edits
    eventSource.on(event_types.MESSAGE_EDITED, async (messageId) => {
        if (!extension_settings[EXT_NAME].autoRender) return;
        // Give the DOM a tick to re-render the edited message
        setTimeout(() => processMessage(messageId), 100);
    });

    // Re-process all messages when chat loads (handles existing history)
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (!extension_settings[EXT_NAME].autoRender) return;
        const ctx = getContext();
        if (!ctx.chat?.length) return;
        // Small delay so ST finishes rendering the full chat
        setTimeout(async () => {
            for (let i = 0; i < ctx.chat.length; i++) {
                await processMessage(i);
            }
        }, 500);
    });
}

// -------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------

jQuery(async () => {
    loadSettings();
    await addSettingsUI();
    registerEvents();

    // Pre-warm abcjs load so first render isn't slow
    loadAbcjs().catch(err => console.warn(`[${EXT_NAME}] abcjs preload failed:`, err));

    console.log(`[${EXT_NAME}] Loaded — abcjs will be fetched from CDN on first use`);
});
