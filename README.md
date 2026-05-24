# ABC Music Player — SillyTavern Extension

Detects ` ```abc ` fenced code blocks in character messages, renders them as
interactive sheet music, and provides playback + download (MIDI / WAV).

---

## Installation

```
SillyTavern/public/scripts/extensions/third-party/abc-music-player/
├── manifest.json
├── index.js
├── style.css
└── settings.html
```

Enable in **Extensions → ABC Music Player**.  
abcjs (~483KB) is fetched from jsDelivr CDN the first time a block renders.
After that it's cached by the browser. Requires network on first load.

---

## File overview

| File | Purpose |
|---|---|
| `manifest.json` | Extension metadata and entry points |
| `index.js` | All logic: ABC detection, widget build, playback, WAV/MIDI export |
| `style.css` | Widget styles using ST CSS variables (theme-aware) |
| `settings.html` | Settings panel injected into ST's Extensions tab |

---

## How it works

1. `CHARACTER_MESSAGE_RENDERED` fires after each AI message is rendered to DOM
2. Extension queries `pre code.language-abc` elements (standard markdown code fence output)
3. For each unprocessed block: parses ABC string, builds a player widget, replaces the `<pre>` in-place
4. abcjs renders the ABC as SVG sheet music into the widget
5. Play/Stop use abcjs's Web Audio synth (loads FluidR3_GM soundfont per-note from paulrosen's GitHub Pages CDN)
6. MIDI export: `ABCJS.synth.getMidiFile()` → base64 data URI → `.mid` download
7. WAV export: `OfflineAudioContext` render → 16-bit stereo PCM → `.wav` download

The extension also hooks `MESSAGE_EDITED` and `CHAT_CHANGED` to handle reloads
and edited messages. Already-processed blocks are marked with
`data-abc-processed` to prevent double-rendering.

---

## WAV export notes

WAV uses `OfflineAudioContext` — renders faster than real-time (no waiting for
playback to finish). The duration is estimated from barline count × ms/measure,
with a 4-second tail appended to avoid cutting off decay.

**Potential gotcha:** If the WAV comes out silent, it likely means abcjs's
synth couldn't load soundfont samples into the OfflineAudioContext before
`startRendering()` was called. In that case:

1. Click **Play** once to warm up and fully load the soundfont  
2. Then click **WAV** — the offline render should succeed

If WAV export remains unreliable, use **MIDI** instead and convert with
FluidSynth: `fluidsynth -F out.wav /usr/share/soundfonts/GeneralUser-GS.sf2 out.mid`

---

## Prompting Alastor to generate ABC

Add something like this to his system prompt or Author's Note:

```
When composing or describing music, Alastor may notate it in ABC format inside
a ```abc code block. The notation will be rendered as interactive sheet music
with playback. He should include X:, T:, M:, L:, Q:, K:, and at least one
voice. For multi-instrument pieces, assign each voice a %%MIDI program number
(General MIDI, 0-indexed) immediately after the V: declaration.

Common instruments:
  4  = Electric Piano    32 = Acoustic Bass    56 = Trumpet
  11 = Vibraphone        57 = Trombone         65 = Alto Sax
  26 = Jazz Guitar       66 = Tenor Sax        73 = Flute

All voices must have the same number of beats per bar or playback will break.

Example of valid multi-instrument ABC:

```abc
X:1
T:Late Night
M:4/4
L:1/8
Q:1/4=110
K:Eb
V:1 name="Alto Sax"
%%MIDI program 65
|: G4 F2 ED | C6 DE | F4 E2 DC | B,8 :|
V:2 name="Piano"
%%MIDI program 4
|: e2ce gceg | c8 | d2Bd fBdf | g8 :|
V:3 name="Acoustic Bass"
%%MIDI program 32
|: C,4 G,4 | C,4 G,4 | F,4 C,4 | G,8 :|
```
```

The model doesn't need to be told about the extension machinery — just that
it can write ABC notation and it will play. Alastor knowing it actually works
is half the fun.

---

## ABC notation quick reference

```
X:1          ← tune index (required, always 1 for single tunes)
T:Title      ← title (shown in widget header)
C:Composer   ← optional
M:3/4        ← time signature (3/4, 4/4, 6/8, C, C|, etc.)
L:1/8        ← default note length (1/4, 1/8, 1/16)
Q:1/4=120    ← tempo: quarter note = 120 BPM
K:Dmin       ← key (Cmaj, Dmin, G, Bb, F#m, etc.)

Notes: A B C D E F G  (uppercase = octave 4)
       a b c d e f g  (lowercase = octave 5)
       A, B,          (comma = drop octave)
       a' b'          (tick = raise octave)
       ^A _B =C       (sharp, flat, natural)
       A2             (length multiplier: double)
       A/2 or A/      (half length)
       z              (rest)
       |              (barline)
       ||             (double barline / section end)
       |:  :|         (repeat start/end)
       [|  |]         (first/second ending use [1 [2)
       "Am"A          (chord symbol above note)
       (3ABC          (triplet)
```

### Common key signatures
`K:C` `K:G` `K:D` `K:A` `K:E` `K:F` `K:Bb` `K:Eb`  
`K:Am` `K:Dm` `K:Em` `K:Bm` `K:Gm`

### Multi-voice example
```abc
X:1
T:Two Voices
M:4/4
L:1/8
K:C
V:1 clef=treble
E4 GFED | C8 |
V:2 clef=bass
C,4 G,4   | C,8 |
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Enabled | on | Master toggle |
| Auto-render | on | Process messages automatically on receive |
| Show notation | on | Whether sheet music is visible by default (can toggle per-widget) |
| Tempo multiplier | 1.0 | Speed up (>1) or slow down (<1) all playback and WAV renders |

---

## Known limitations

- **No vocals** — ABC and abcjs are instrumental only; this is fine
- **Soundfont size** — FluidR3_GM fetches per-note MP3s (~80KB each) from
  paulrosen's GitHub Pages CDN, lazy-loaded on first Play click. A 3-instrument
  tune might pull 2–3MB on first load; all cached after that. If the CDN is
  slow or you want offline support, mirror the note files locally and update
  `SOUNDFONT_URL` in `index.js`.
- **AAC not implemented** — WAV is lossless and universally convertible.
  If you need AAC: `ffmpeg -i out.wav -c:a aac -b:a 192k out.aac`
- **Long compositions** — WAV export estimates duration from barline count.
  Very long pieces (>5 min) may get cut off; increase the tail in
  `estimateDurationSeconds()` if needed.
- **Offline use** — abcjs is CDN-loaded. No internet = no first load.
  Bundle abcjs locally if you need offline support: download
  `abcjs-basic-min.js` into the extension folder and change `ABCJS_CDN` in
  `index.js` to a relative path (`./abcjs-basic-min.js`).

---

## Dependencies

- [abcjs](https://paulrosen.github.io/abcjs/) v6.4.4 (MIT) — loaded from jsDelivr
- SillyTavern ≥ 1.12.0
- DOMPurify (bundled with ST, used for title sanitization)
