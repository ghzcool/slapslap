# SlapSlap

Translates video by replacing voices by similarly sounding translated voices.


## Prerequisites

- Node.js and npm
- `ffmpeg` / `ffprobe` on PATH
- An LLM for translation (step 5): LM Studio running at http://localhost:1234 (default), or an OpenRouter API key for the cloud provider (see [Configuration](#configuration))
- Python 3.11
- Python ML env `venv-ml` for Demucs + Whisper:
  ```
  py -3.11 -m venv venv-ml
  venv-ml\Scripts\activate
  python -m pip install --upgrade pip
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
  pip install demucs soundfile
  pip install -U openai-whisper
  ```

## Setup

The default voice engine is **VoxCPM2**. Its Python environment and model live inside
the project and are created once after cloning (the first run needs internet):

```
setup.bat
```

(`setup.bat` wraps `powershell -ExecutionPolicy Bypass -File setup.ps1`.) The script
creates `venv-voxcpm\`, installs VoxCPM2 + CUDA torch and Node dependencies, and
downloads the `openbmb/VoxCPM2` model into `models\VoxCPM2\`. Use `-Cpu` for a
CPU-only torch build (then also set `VOXCPM_DEVICE=cpu` when running), or
`-Python <path>` to choose a specific Python 3.11 interpreter.

## Configuration

Settings are read from a project-local `.env` file (no extra dependency). Copy the
sample once and edit it:

```
cp .env.example .env
```

(on Windows: `copy .env.example .env`). The pipeline loads `.env` automatically at
startup; variables already present in the real environment always take precedence
over `.env`. `.env` is gitignored.

### LLM provider

`LLM_PROVIDER` selects the translation backend used in step 5:

- `lmstudio` (default) — local LM Studio server. Requires LM Studio running at
  `LMSTUDIO_API_URL` (default `http://localhost:1234`) and **no API key**.
  Model: `LM_MODEL` (default `qwen/qwen3.6-35b-a3b`); `LM_API_TOKEN` is optional.
- `openrouter` — OpenRouter cloud API. Requires `OPENROUTER_API_KEY`; model:
  `OPENROUTER_MODEL` (default `openai/gpt-4o-mini`). Optional
  `OPENROUTER_API_URL`, `OPENROUTER_SITE_URL` and `OPENROUTER_SITE_NAME`
  (attribution headers).

The CLI `-m <model>` flag overrides `LM_MODEL` / `OPENROUTER_MODEL`.

Reasoning models (e.g. `deepseek/...`) are supported: thinking is disabled per
provider (`reasoning: { enabled: false }` on OpenRouter, `chat_template_kwargs` on
LM Studio), and every request uses a token floor of `LLM_MIN_MAX_TOKENS`
(default `1024`) so the model does not spend its whole budget on hidden reasoning
and return empty content. If a model still answers with nothing, the pipeline
raises a clear error instead of returning an empty translation.

Other supported variables: `DEVICE` (`cuda`/`cpu`), `TTS_METHOD` (`voxcpm`/`qwen3`),
and the optional `VOXCPM_*` options. See `.env.example` for the full list.

```
# local (default)
LLM_PROVIDER=lmstudio
LM_MODEL=qwen/qwen3.6-35b-a3b

# cloud
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

## What does it do

Get sound from video and save it as separate file.
Separate audio to voice and other sounds and save as 2 separate files.
Get text, timecodes and durations from these parts using voice to text.
Split voice audio to parts.
Translate texts using the configured LLM provider (LM Studio by default, or OpenRouter). Give llm full text so it understand context and ask to translate each part separately.
Create audio files for each translated part using the original voice as a reference (VoxCPM2 by default, or Qwen3-TTS with `--method qwen3`), keep same duration.
Join translated audio files in one with right positions based on timecodes.
Combine audio file with no voices and audio file with translated voices.
Make new video file from original video with replaced audio to translated one.

## Usage

```
npx slapslap <video-file> [language] [-d] [-s <step>] [-m <model>] [--method <engine>]
```

- `language` — target language (default: `russian`)
- `-d` — dub mode: skip adding the muted original voice overlay in step 9
- `-s <step>` — skip to step (1-9) for re-running
- `-m <model>` — LLM model to use (overrides `LM_MODEL` / `OPENROUTER_MODEL`)
- `--method <engine>` — TTS voice engine: `voxcpm` (default, VoxCPM2) or `qwen3` (old Qwen3-TTS `generate_audio.exe`)
- Flags can appear anywhere in the argument list

Examples:
```
npx slapslap sample.mp4 russian -d -s 5
npx slapslap -s 5 sample.mp4 japanese -d
npx slapslap sample.mp4              # runs all steps, default language = russian
npx slapslap sample.mp4 --method qwen3  # old Qwen3-TTS engine
```

## Issues

### Minor
- tts quality is not the best. Need to try OmniVoice

## Changes

- More or less fixed voice speed with changes in prompts, addidg double check of extra text in translation and improved voice spped logic. In some cases translations for short phrases have very different length with original and it's not clear how to fix that.
- Improved speech to text by changing model to better one.
- Tested different LLM's: Good enough translation results with qwen3.6-35b-a3b. qwen3.5-9b is faster and also not bad.
- Voice separated from audio and combined back in the end
- Added original voice with 20% volume for lipsink.
- Start LLM only when it's needed and stop it after.
- Added `.env` support (see `.env.example`) and an OpenRouter cloud LLM provider selectable with `LLM_PROVIDER`.
