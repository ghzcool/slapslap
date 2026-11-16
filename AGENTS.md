# SlapSlap — Agent Instructions

IMPORTANT: ALWAYS START WITH MESSAGE "I FOLLOW RULES FROM `AGENTS.md`"

## Repo layout

```
index.js          # Single-file pipeline (entrypoint)
generate_audio.exe # qwen3-tts-rs Windows binary (~18MB, do not delete)
models/base-1.7b/ # Qwen3-TTS weights (large, gitignored)
venv-ml/          # Python ML environment (demucs, whisper)
work/             # Runtime working directory (gitignored)
TTS_RS_README.md  # TTS setup reference
voxcpm_worker.py  # VoxCPM2 batch worker (default voice engine)
venv-voxcpm/      # VoxCPM2 Python env, created by setup.ps1 (gitignored)
models/VoxCPM2/   # VoxCPM2 weights, downloaded by setup.ps1 (gitignored)
requirements.txt  # VoxCPM2 Python deps
setup.ps1 / setup.bat # one-time project-local env + model setup
.env.example      # sample env file (copy to .env; .env is gitignored)
```

## Run

```
npx slapslap <video-file> [language] [-d] [-s <step>] [-m <model>] [--method <engine>]
```

- `language` — target language (default: `russian`)
- `-d` — dub mode: skip adding the muted original voice overlay in step 9
- `-s <step>` — skip to step (1-9) for re-running
- `--method <engine>` — TTS voice engine: `voxcpm` (default, VoxCPM2) or `qwen3` (old Qwen3-TTS `generate_audio.exe`)
- Flags can appear anywhere in the argument list

Examples:
```
npx slapslap sample.mp4 russian -d -s 5
npx slapslap -s 5 sample.mp4 japanese -d
npx slapslap sample.mp4                        # runs all steps, default language = russian, VoxCPM2 engine
npx slapslap sample.mp4 --method qwen3         # use the old Qwen3-TTS generate_audio.exe engine
```

- Default voice engine is **VoxCPM2**, run through the project-local `venv-voxcpm\`; `--method qwen3` selects the old Qwen3-TTS `generate_audio.exe`.
- `venv-ml` must be activated with CUDA support. Demucs and whisper are installed here.
- LM Studio must be running on `http://localhost:1234` before step 5.
- First run: execute `setup.bat` (or `setup.ps1`) once to create `venv-voxcpm/` and download `models/VoxCPM2/` for the default VoxCPM2 engine.

## Key constraints

- `index.js` has no abstraction layer — all subprocess calls use `execSync` or `spawn` directly.
- Step order matters: each step depends on output from the previous one.
- `LM_MODEL` / `LM_MODEL_LARGE` env vars override the default LLM models.
- Env vars can be provided via a project-local `.env` file (loaded at startup, no dependency); real env vars win over `.env`. See `.env.example`.
- `LLM_PROVIDER` selects the translation LLM: `lmstudio` (default, local, no key) or `openrouter` (cloud, needs `OPENROUTER_API_KEY`, model via `OPENROUTER_MODEL`). LM Studio model load/unload is skipped for OpenRouter. All chat calls go through `llmChatCompletion()`.
- `LM_API_TOKEN` env var is optional; defaults to `'none'` (no auth header).
- The `rules` constant (line 272) is injected into every translation LLM prompt — changing it requires re-running the full pipeline.
- `doubleCheckWithLLM` is commented out in `step5` by default.
- `step9_makeVideo` mixes original voice at 0.2 volume into the final audio — this replaced the old version.
- Demucs output path is `work/audio/demucs/htdemucs/<basename>/vocals.wav` and `no_vocals.wav`.
- Steps 2–3 split `voice.wav` into voice parts by silence (`ffmpeg silencedetect`) and transcribe each part individually with Whisper — the whole-track `transcript.json` / `voice.json` is no longer produced or required.
- `generate_audio.exe` is called with `--ref-audio` pointing to each original part for voice cloning — do not change the ref-audio logic.
- Step 6 uses VoxCPM2 by default (`voxcpm_worker.py` run through `venv-voxcpm\Scripts\python.exe`, model `openbmb/VoxCPM2`, reference audio = each original part wav); `--method qwen3` restores the old `generate_audio.exe` engine; `TTS_METHOD` env var overrides; VoxCPM runs in `reference` mode by default (`VOXCPM_MODE=ultimate` uses the original transcript as prompt).
- The project is self-contained: apart from documented prerequisites (system `ffmpeg`, LM Studio at `http://localhost:1234`, `venv-ml`), no path outside the repo is used. VoxCPM2's env and model live in `venv-voxcpm/` and `models/VoxCPM2/` and are created by `setup.ps1`.

## Subagent workflow

- **coder** — use for every implementation task (code changes, new features, bug fixes, refactoring).
- **tester** — after coder finishes, always run tester to review the result.
  - If tester approves → task is done.
  - If tester finds issues → return the list of issues to coder for correction.
- Never skip the tester review step.
- Also use tester if task requires that.

## Skills

- **grill-me** — a relentless interview to sharpen a plan or design. Invokes `/grilling`.
- **grilling** — stress-test a plan, decision, or idea by interviewing the user relentlessly until a shared understanding is reached (design tree in rounds).
- **handoff** — compact the current conversation into a handoff document (saved to the OS temp dir) so a fresh agent can continue the work.

## Testing / verification

- No automated tests. Just review code.
- Run script on sample.mp4 to verify that it works as expected.
