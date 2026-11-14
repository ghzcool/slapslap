import argparse
import json
import os
import re
import time

import numpy as np

SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def split_text(text, max_chars):
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    pieces = []
    for sentence in SENTENCE_SPLIT.split(text):
        if len(sentence) <= max_chars:
            pieces.append(sentence)
            continue
        current = ""
        for word in sentence.split():
            if len(current) + len(word) + 1 <= max_chars or not current:
                current = (current + " " + word).strip()
            else:
                pieces.append(current)
                current = word
        if current:
            pieces.append(current)

    chunks = []
    current = ""
    for piece in pieces:
        if len(current) + len(piece) + 1 <= max_chars or not current:
            current = (current + " " + piece).strip()
        else:
            chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    return chunks


def write_status(handle, record):
    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    handle.flush()


def main():
    parser = argparse.ArgumentParser(description="Batch VoxCPM2 voice cloning worker")
    parser.add_argument("--jobs", required=True, help="JSONL file with generation jobs")
    parser.add_argument("--status", required=True, help="JSONL file for per-job results")
    parser.add_argument("--model", default="openbmb/VoxCPM2")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--denoise", action="store_true")
    parser.add_argument("--optimize", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    with open(args.jobs, "r", encoding="utf-8") as handle:
        jobs = [json.loads(line) for line in handle if line.strip()]

    os.makedirs(os.path.dirname(args.status) or ".", exist_ok=True)
    status_handle = open(args.status, "w", encoding="utf-8")

    if not jobs:
        status_handle.close()
        print("no voxcpm jobs", flush=True)
        return

    from voxcpm import VoxCPM
    import soundfile as sf
    import torch

    started = time.time()
    model = VoxCPM.from_pretrained(
        args.model,
        load_denoiser=args.denoise,
        optimize=args.optimize,
        device=args.device,
    )
    sample_rate = model.tts_model.sample_rate
    print(f"voxcpm loaded in {time.time() - started:.1f}s, sample_rate={sample_rate}", flush=True)

    for index, job in enumerate(jobs, 1):
        record = {"asset": job.get("asset", str(index)), "ok": False}
        try:
            output = job["out"]
            valid = False
            if (not args.force) and os.path.exists(output) and os.path.getsize(output) > 1000:
                try:
                    info = sf.info(output)
                    valid = info.frames > 0
                except Exception:
                    valid = False
            if valid:
                record.update(ok=True, skipped=True, out=output)
            else:
                os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
                chunks = split_text(job["text"], int(job.get("max_chars", 220)))
                parts = []
                for chunk_index, chunk in enumerate(chunks):
                    torch.manual_seed(int(job.get("seed", 42)) + chunk_index)
                    kwargs = {
                        "text": chunk,
                        "cfg_value": float(job.get("cfg", 2.0)),
                        "inference_timesteps": int(job.get("timesteps", 10)),
                        "denoise": bool(job.get("denoise", False)),
                    }
                    if job.get("mode", "reference") == "ultimate":
                        kwargs.update(
                            prompt_wav_path=job["ref"],
                            prompt_text=job.get("prompt_text", ""),
                            reference_wav_path=job["ref"],
                        )
                    else:
                        kwargs["reference_wav_path"] = job["ref"]
                    wav = model.generate(**kwargs)
                    parts.append(np.asarray(wav, dtype=np.float32))
                    if chunk_index < len(chunks) - 1 and float(job.get("gap", 0.15)) > 0:
                        parts.append(np.zeros(int(sample_rate * float(job.get("gap", 0.15))), dtype=np.float32))

                audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
                peak = float(np.max(np.abs(audio))) if audio.size else 0.0
                if peak > 0.99:
                    audio = audio * (0.99 / peak)
                sf.write(output, audio, sample_rate, subtype="PCM_16")
                record.update(
                    ok=True,
                    out=output,
                    sec=round(len(audio) / sample_rate, 3),
                    chunks=len(chunks),
                )
            print(f"[{index}/{len(jobs)}] {record['asset']} -> {output}", flush=True)
        except Exception as exc:
            record["error"] = str(exc)
            print(f"[{index}/{len(jobs)}] FAILED {record.get('asset')}: {exc}", flush=True)
        write_status(status_handle, record)

    status_handle.close()


if __name__ == "__main__":
    main()
