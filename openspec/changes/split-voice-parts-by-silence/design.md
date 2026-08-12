## Context

`index.js` is a single-file linear pipeline (steps 1–9, with step 4 removed). Today the audio path is:

1. Extract audio, separate voice via Demucs (`voice.wav`).
2. Whisper the **whole** `voice.wav` with `--word_timestamps True` → `transcript.json`.
3. `mergeSegmentsToSentences` merges words into sentences (2 s pause threshold, 15 s hard cap), then ffmpeg cuts audio parts from `voice.wav` using those text-derived timings.

The flaw: part timing depends entirely on Whisper alignment across a long file. Whisper drift, merged segments, or noisy transcript boundaries produce wrong cuts, which then become bad TTS ref-audio and out-of-sync joins. Because `voice.wav` is already voice-separated (Demucs vocals), silence detection gives cleaner, exact voice boundaries than Whisper alignment does.

Downstream steps 5 (translate), 6 (TTS), 7 (join), 8 (mix), 9 (video) all consume `parts.json` with `{ start, end, text, translated, file }` and must keep working unchanged. Step 7 additionally reads `transcript.json` for word-level gap computation — this dependency is removed.

## Goals / Non-Goals

**Goals:**
- Split `voice.wav` into voice parts with exact timing using silence gaps (min gap = `MIN_SILENCE_CUT`, default `1.0` s).
- Drop noise fragments (RMS volume below `VOLUME_MIN_DB`) and too-short fragments (min `0.1` s).
- Transcribe each voice part individually (Whisper `large-v3`, word timestamps, timings offset to global time).
- Split text (and its timing) only when a part is too long (> 15 s), reusing the existing sentence-merge logic.
- Keep steps 5–9 consuming the same `parts.json` shape with no changes.
- Replace step 7's `transcript.json` gap logic with part-boundary gap logic.

**Non-Goals:**
- No sentence-based pre-splitting of audio before transcription.
- No changes to translation, TTS, mixing, or video assembly behavior.
- No new dependencies.
- Not tuning `SILENCE_NOISE_DB` / `VOLUME_MIN_DB` scientifically — defaults chosen and verified on `sample.mp4`.

## Decisions

### 1. Silence detection via ffmpeg `silencedetect` (not `silenceremove` / pydub)
Run `ffmpeg -i voice.wav -af silencedetect=noise=SILENCE_NOISE_DB:d=MIN_SILENCE_CUT -f null -` and parse `silence_start` / `silence_end` lines from the combined output (append `2>&1`, ffmpeg writes them to stderr; on Windows capture combined stdout). 

- Voice intervals are the spans **between** a `silence_end` and the next `silence_start`, plus the head/tail spans implied by the file duration. This naturally trims leading and trailing silence (a file-start `silence_start: 0` or file-end `silence_end` collapses them to zero-length edges).
- Constants: `SILENCE_NOISE_DB = -25` (tuned from -35 after dorohedoro.mp4 run: anime vocals carry a music bleed floor around -23 to -30 dB, so -35 missed all but the tail silence; -25 cleanly separates intro/outro music from dialogue), `MIN_SILENCE_CUT = 1.0` s.
- *Alternative considered:* `silenceremove` trims audio in-place but destroys the original timing, which we need for TTS ref-audio and join. `pydub` would add a dependency. Rejected.

### 2. Noise + length filtering per candidate fragment
Each candidate interval is probed with `ffmpeg -i <frag> -af volumedetect -f null -` and its `mean_volume` parsed. Parts with `mean_volume < VOLUME_MIN_DB` (`-40`) or `duration < MIN_PART_SECONDS` (`0.1` s) are dropped.
- Rationale: silence detection can pass breath/mouth-click/noise-bleed fragments; RMS is a cheap, reliable guard. Very short but loud words like "yes"/"no" survive because the cutoff is volume, not length.

### 3. Part cutting with small edge padding
Cut each accepted interval with `PADDING_SECONDS = 0.1` s of silence on both sides (clamped to `[0, duration]`) so the TTS ref-audio and generated audio don't clip phonemes at the exact voice boundary. Because `MIN_SILENCE_CUT = 1.0` s, adjacent padded parts never overlap.

### 4. Per-part Whisper with word timestamps, global time offset
For each part: `python -m whisper <part> --model large-v3 --output_format json --output_dir <partDir> --word_timestamps True --condition_on_previous_text False`. Whisper emits a JSON per input file; parse its words, then offset every word's `start`/`end` by the part's `start` to get global times. Part `text` is the concatenated words (same `join('')` behavior as today).
- Word timestamps are required for the length-split (decision 5); per-part runs avoid whole-file drift and give short, clean transcripts.
- *Alternative considered:* segment-level only (faster) — rejected because the length-split needs word-level punctuation/pause detection to mirror the old sentence merging.

### 5. Length-based text split reusing the existing sentence logic
Do **not** pre-split voice parts by sentence. Only when a transcribed part exceeds `MAX_PART_SECONDS = 15` (the old hard cap) run the existing `mergeSegmentsToSentences` over that part's global-offset words; each resulting sentence becomes a sub-part with its own cut audio, timing, and text. `mergeSegmentsToSentences` already enforces the 2 s pause threshold and 15 s cap internally, so "check current limits" is satisfied by reuse.

### 6. `transcript.json` removed; step 7 gaps come from part boundaries
The whole-track transcript is no longer produced. Step 7 currently reads it to find neighboring words for the timing-window extension (`gapBefore`/`gapAfter`). Replace with the final parts list: `gapBefore = prev ? max(0, p.start - prev.end) : 0`, `gapAfter = next ? max(0, next.start - p.end) : 0`. Since gaps between parts are exactly the removed silence, this yields the same input to the existing window-extension math; the rest of step 7 is untouched.

### 7. Constants placement and step semantics
All new constants live with the other pipeline config near the top of `index.js`. `-s` semantics preserved: step 2 = split by silence, step 3 = transcribe each part (+ length split). `parts.json` schema unchanged.

## Risks / Trade-offs

- [Silence threshold too aggressive → voice split mid-word] → `SILENCE_NOISE_DB` is a constant; tune on `sample.mp4`, then set default. Volumedetect also rescues quiet fragments.
- [Silence threshold too lax → long merged part] → length split (>15 s) re-introduces sentence boundaries; worst case a part is slightly longer than ideal, same as today's 15 s cap.
- [Per-part Whisper = many small processes → slower step 3] → acceptable; each file is short and clean, and per-part `condition_on_previous_text False` avoids cross-part hallucination.
- [Whisper per part produces no cross-part context for translation] → already mitigated by step 5, which sends the full text as context to the LLM.
- [Windows shell quoting for per-part whisper/volumedetect] → same patterns already used in the repo (`run()` with `execSync`, escaped paths); silencedetect/volumedetect use combined `2>&1` capture.
- [Removing `transcript.json` breaks `-s 7` resume from an old run] → acceptable; old `work/` dirs are gitignored runtime state. Re-running from step 2 regenerates.

## Migration Plan

1. Implement step 2 (split + filter + cut) and step 3 (per-part whisper + length split) alongside the new constants.
2. Update step 7 to drop the `transcript.json` read and compute gaps from `parts`.
3. Verify on `sample.mp4`: `npx slapslap sample.mp4 russian`; inspect `parts.json` timing sanity, listen to a few cut parts, confirm join/mix/video output.
4. Rollback: old behavior is recoverable from git history; `-s 5`/`-s 6`/etc. continue to work on a retained `parts.json`.

## Open Questions

- Default `SILENCE_NOISE_DB = -25` and `VOLUME_MIN_DB = -40` were tuned after `sample.mp4` and `dorohedoro.mp4` runs (the constants make this a one-line change).
