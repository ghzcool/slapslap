# SlapSlap

Translates video by replacing voices by similarly sounding translated voices.


## Tech stack

Nodejs, ffmpeg, fs, CMD, local AI's

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
node index.js video-file-name.mp4
```

wait

grab translated-video-file-name.mp4

enjoy