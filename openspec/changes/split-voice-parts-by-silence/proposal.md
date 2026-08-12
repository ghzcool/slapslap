## Why

The current pipeline runs Whisper on the whole voice track once and then derives sentence timing from word timestamps, cutting audio afterwards. On long or messy audio this misaligns text with audio (Whisper drifts, long segments, wrong cut boundaries), producing bad TTS ref-audio and out-of-sync dubs. Since Demucs output contains only voice, we can split it into exact voice parts purely by silence — getting precise timing without relying on Whisper alignment.

## What Changes

- Replace "Whisper the whole track → cut text parts by timing" with "split voice track by silence → transcribe each voice part individually".
- Add a `MIN_SILENCE_CUT` constant: any silence gap ≥ this value (default `1.0` s) separates one voice part from the next. Parts are cut exactly at voice boundaries.
- Split uses ffmpeg `silencedetect` on the separated vocals; detected voice intervals get exact start/end timings.
- Add a `VOLUME_MIN_DB` constant: fragments whose RMS volume is below it (default `-40` dB) are treated as noise and dropped.
- Add a minimum part length filter (`0.1` s) — fragments shorter than this are dropped too.
- Each voice part is transcribed individually with Whisper `large-v3` and `--word_timestamps True`, with timings offset by the part start into global time.
- Do NOT pre-split voice parts into sentences before transcription. Only split a part's text (and its timing) when it exceeds a length limit, reusing the current sentence-merge logic (2 s pause threshold, 15 s max length) over that part's word timestamps.
- Step 7 (join) computes gap-before/gap-after from the final part boundaries instead of reading `transcript.json`; the full-track transcript file is no longer produced or required.
- Steps 5 (translate), 6 (TTS per part), 8 (mix), 9 (video) keep working unchanged — they consume the same `parts.json` shape.

## Capabilities

### New Capabilities
- `voice-part-splitting`: silence-based splitting of the separated vocals into exact voice parts, noise/RMS filtering, per-part Whisper transcription, and length-based text splitting.

### Modified Capabilities
<!-- No existing specs; all behavior is new. -->

## Impact

- `index.js` only — step 2 (speech-to-text) and step 3 (parse + cut) are reworked; step 7's gap computation loses its `transcript.json` dependency.
- No new dependencies: ffmpeg `silencedetect` is already available via ffmpeg; Whisper invocation unchanged per file.
- `-s` step semantics preserved (2 = split by silence, 3 = transcribe parts); `parts.json` schema unchanged so downstream steps are untouched.
- Rerunning a full pipeline on `sample.mp4` is required to verify.
