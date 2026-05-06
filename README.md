# SlapSlap

Translates video by replacing voices by similarly sounding translated voices.


## Tech stack

Nodejs, ffmpeg, fs, CMD, local AI's

py -3.11 -m venv venv-ml
venv-ml\Scripts\activate

python -m pip install --upgrade pip

pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

pip install demucs

pip install soundfile

pip install -U openai-whisper

## What does it do

Get sound from video and save it as separate file.
Separate audio to voice and other sounds and save as 2 separate files.
Get text, timecodes and durations from these parts using voice to text.
Split voice audio to parts.
Translate texts using local LM Studio server. Give llm full text so it understand context and ask to translate each part separately.
Create audio files for each translated part using original voice as reference, keep same duration. Use locally running cli app with qwen3-tts.
Join translated audio files in one with right positions based on timecodes.
Combine audio file with no voices and audio file with translated voices.
Make new video file from original video with replaced audio to translated one.

## Usage

run
```
node index.js video-file-name.mp4 russian
```

wait

grab russian_video-file-name.mp4

enjoy

## Issues

### Major
- need to separate voice from other sounds and combine with them in the end

## Minor
- tts quality is not the best

## Changes

- More or less fixed voice speed with changes in prompts, addidg double check of extra text in translation and improved voice spped logic. In some cases translations for short phrases have very different length with original and it's not clear how to fix that.
- Improved speech to text by changing model to better one.
- Tested different LLM's: Good enough translation results with qwen3.6-35b-a3b. qwen3.5-9b is faster and also not bad.