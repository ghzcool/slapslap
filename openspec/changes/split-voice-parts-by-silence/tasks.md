## 1. Constants

- [x] 1.1 Add pipeline constants near the top of `index.js` (with the other config): `MIN_SILENCE_CUT = 1.0`, `SILENCE_NOISE_DB = -35`, `VOLUME_MIN_DB = -40`, `MIN_PART_SECONDS = 0.1`, `PADDING_SECONDS = 0.1`, `MAX_PART_SECONDS = 15`

## 2. Step 2 — Split voice track by silence

- [x] 2.1 Rewrite `step2_speechToText` as `step2_splitBySilence`: run `ffmpeg -i voice.wav -af silencedetect=noise=<SILENCE_NOISE_DB>dB:d=<MIN_SILENCE_CUT> -f null -` capturing combined output (`2>&1`) and parse all `silence_start` / `silence_end` lines
- [x] 2.2 Probe total duration of `voice.wav` via `ffprobe` and derive voice intervals from the silence intervals (span between each `silence_end` and the next `silence_start`, plus head/tail from duration; collapse zero-length edges from file-start/file-end silence)
- [x] 2.3 Probe each candidate interval's RMS `mean_volume` with `ffmpeg -i <frag> -af volumedetect -f null -` and drop intervals below `VOLUME_MIN_DB`
- [x] 2.4 Drop intervals shorter than `MIN_PART_SECONDS`
- [x] 2.5 Build `parts` array (`{ start, end, text: '', translated: '', file }`), cut each part into `PARTS_DIR` with `PADDING_SECONDS` padding clamped to `[0, duration]`, and call `saveParts()`

## 3. Step 3 — Transcribe each part individually

- [x] 3.1 Rewrite `step3_parseTranscriptAndCut` as `step3_transcribeParts`: for each part run Whisper on its file (`--model large-v3 --output_format json --output_dir <partDir> --word_timestamps True --condition_on_previous_text False`) and parse the per-file JSON
- [x] 3.2 Offset each word's `start`/`end` by the part's `start` to global time and set `part.text` as the concatenated words (same `join('')` semantics as today)
- [x] 3.3 For parts longer than `MAX_PART_SECONDS`, re-split via `mergeSegmentsToSentences` over the part's global-offset words into sub-parts, each with its own cut audio, global timing, and text; leave short parts whole
- [x] 3.4 `saveParts()` and drop the old `transcript.json` rename logic

## 4. Step 7 — Join without transcript.json

- [x] 4.1 Remove the `transcript.json` read and `allWords` collection from `step7_joinAudio`
- [x] 4.2 Compute `gapBefore`/`gapAfter` from the previous/next part boundaries in the (time-sorted) parts list instead of neighboring words; keep the rest of the window-extension math unchanged

## 5. Cleanup

- [x] 5.1 Remove or update references to `transcriptFile`/`textFile` in `index.js` so the whole-track transcript is no longer produced or required
- [x] 5.2 Update AGENTS.md "Key constraints" notes describing the old step 2/3 transcript-and-cut flow (e.g., `transcript.json`, `voice.json`) to the silence-split + per-part whisper flow

## 6. Verification

- [x] 6.1 Run `npx slapslap sample.mp4 russian` end-to-end and confirm `parts.json` contains parts with plausible voice-only timing, all cut files exist, and steps 5–9 complete (translation, TTS, join, mix, video)
- [ ] 6.2 Spot-check audio: listen to a couple of cut parts (voice only, no dead air at edges), verify join has no overlapping/dropped speech
- [x] 6.3 If parts look over/under-split, adjust `SILENCE_NOISE_DB` / `VOLUME_MIN_DB` / `MIN_SILENCE_CUT` defaults and re-run from `-s 2`
