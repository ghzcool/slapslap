## ADDED Requirements

### Requirement: Split voice track into parts by silence
The system SHALL split the voice-separated audio track (`voice.wav`) into parts at silence gaps whose duration is at least `MIN_SILENCE_CUT` seconds (default `1.0`). Each resulting part SHALL contain only the span between two such silence gaps, so parts start and end at voice boundaries. The system SHALL record an exact start and end time (in seconds) for every part.

#### Scenario: Typical pauses between utterances
- **WHEN** the voice track contains utterances separated by silence gaps of 1.0 s or more
- **THEN** the system produces one part per utterance with `start` and `end` matching the voice boundaries and excluding the separating silence

#### Scenario: Silence shorter than the threshold
- **WHEN** two utterances are separated by a silence gap shorter than `MIN_SILENCE_CUT`
- **THEN** they remain inside a single part

#### Scenario: Leading or trailing silence
- **WHEN** the voice track has silence at its beginning or end
- **THEN** the first part starts at the first voice sample and the last part ends at the last voice sample

### Requirement: Discard noise and too-short fragments
The system SHALL drop a candidate part when its RMS mean volume is below `VOLUME_MIN_DB` (default `-40` dB) or its duration is below `MIN_PART_SECONDS` (default `0.1` s). These parts SHALL NOT appear in `parts.json` nor be cut to disk.

#### Scenario: Noise fragment survives silence detection
- **WHEN** a candidate part is mostly noise or a breath with mean volume below `VOLUME_MIN_DB`
- **THEN** the part is discarded

#### Scenario: Very short but audible word
- **WHEN** a candidate part contains a short word such as "yes" or "no" with mean volume at or above `VOLUME_MIN_DB`
- **THEN** the part is kept despite being shorter than `MIN_PART_SECONDS`

#### Scenario: Extremely short fragment
- **WHEN** a candidate part is shorter than `MIN_PART_SECONDS`
- **THEN** the part is discarded

### Requirement: Cut parts with edge padding
The system SHALL cut each accepted part to its own audio file padded with `PADDING_SECONDS` (default `0.1` s) of silence at both edges, clamped to the track boundaries, and SHALL store the file path in the part's `file` field.

#### Scenario: Padded cut
- **WHEN** a part spans `start`..`end` in the middle of the track
- **THEN** the cut file covers `start - PADDING_SECONDS` .. `end + PADDING_SECONDS`

#### Scenario: Part at track start
- **WHEN** the part begins at the very start of the track
- **THEN** the cut starts at `0` and the leading padding is not applied

### Requirement: Transcribe each voice part individually
The system SHALL run Whisper (`large-v3`, `--word_timestamps True`, `--condition_on_previous_text False`) on every part's audio file separately. Each word timestamp SHALL be offset by the part's start time to global track time. The part's `text` SHALL be the concatenation of its words. The whole-track transcript SHALL NOT be required to produce part text.

#### Scenario: Per-part transcription
- **WHEN** step 3 runs on parts created by the silence split
- **THEN** each part gets a `text` from Whisper output and `translated` initialized empty

#### Scenario: Word times are global
- **WHEN** Whisper returns a word starting at `t` within a part that starts at `S`
- **THEN** the stored word time is `S + t`

### Requirement: Split overlong parts in text
The system SHALL split a transcribed part into sub-parts when it exceeds `MAX_PART_SECONDS` (default `15`) using the sentence-merge logic (2 s pause threshold and 15 s maximum sentence length). The system SHALL NOT pre-split voice parts by sentence before transcription. Each sub-part SHALL get its own cut audio, global timing, and text.

#### Scenario: Part longer than the limit
- **WHEN** a transcribed part is longer than `MAX_PART_SECONDS` and contains several sentences
- **THEN** it is replaced by sub-parts, each with its own audio file, timing, and text, all still in global time

#### Scenario: Short part left whole
- **WHEN** a transcribed part is at or below `MAX_PART_SECONDS`
- **THEN** it is kept as a single part without splitting

### Requirement: Keep parts.json schema and downstream steps working
The system SHALL produce `parts.json` with the existing schema `{ start, end, text, translated, file }` so steps 5 (translate), 6 (TTS), 8 (mix), and 9 (video) run unchanged. The join step SHALL compute `gapBefore`/`gapAfter` from neighboring part boundaries instead of reading the removed whole-track transcript.

#### Scenario: Downstream steps consume new parts
- **WHEN** steps 5–9 run after the new steps 2–3
- **THEN** they read `parts.json` with the same shape and produce the same output artifacts as before

#### Scenario: Join uses part boundaries
- **WHEN** the join step computes the timing window for a part
- **THEN** `gapBefore` uses the previous part's `end` and `gapAfter` uses the next part's `start`
