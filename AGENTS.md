# SlapSlap — Agent Instructions

## Repo layout

```
index.js          # Single-file pipeline (entrypoint)
generate_audio.exe # qwen3-tts-rs Windows binary (~18MB, do not delete)
models/base-1.7b/ # Qwen3-TTS weights (large, gitignored)
venv-ml/          # Python ML environment (demucs, whisper)
work/             # Runtime working directory (gitignored)
TTS_RS_README.md  # TTS setup reference
```

## Run

```
node index.js <video-file> <language> [skip-to-step]
```

- `skip-to-step` (1-9) jumps to a specific step for re-running.
- `venv-ml` must be activated with CUDA support. Demucs and whisper are installed here.
- LM Studio must be running on `http://localhost:1234` before step 5.

## Key constraints

- `index.js` has no abstraction layer — all subprocess calls use `execSync` or `spawn` directly.
- Step order matters: each step depends on output from the previous one.
- `LM_MODEL` / `LM_MODEL_LARGE` env vars override the default LLM models.
- `LM_API_TOKEN` env var is optional; defaults to `'none'` (no auth header).
- The `rules` constant (line 272) is injected into every translation LLM prompt — changing it requires re-running the full pipeline.
- `doubleCheckWithLLM` is commented out in `step5` by default.
- `step9_makeVideo` mixes original voice at 0.2 volume into the final audio — this replaced the old version.
- Demucs output path is `work/audio/demucs/htdemucs/<basename>/vocals.wav` and `no_vocals.wav`.
- `generate_audio.exe` is called with `--ref-audio` pointing to each original part for voice cloning — do not change the ref-audio logic.

## Subagent workflow

- **coder** — use for every implementation task (code changes, new features, bug fixes, refactoring).
- **tester** — after coder finishes, always run tester to review the result.
  - If tester approves → task is done.
  - If tester finds issues → return the list of issues to coder for correction.
- Never skip the tester review step.

## Testing / verification

- No automated tests. Just review code.
