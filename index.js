#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

function parseArgs() {
  const args = process.argv.slice(2);
  let videoFile = null;
  let language = null;
  let skipToStep = 0;
  let dubOnly = false;
  let model = null;
  let i = 0;

  // First non-flag positional arg = video file
  while (i < args.length && args[i].startsWith('-')) {
    i++;
  }
  if (i < args.length) {
    videoFile = args[i];
    i++;
  }

  // Second non-flag positional arg = language
  while (i < args.length && args[i].startsWith('-')) {
    i++;
  }
  if (i < args.length) {
    language = args[i];
    i++;
  }

  // Now parse remaining flags in any order
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '-d':
        dubOnly = true;
        break;
      case '-s':
        i++;
        if (i >= args.length) {
          console.error('Error: -s requires a step number (1-9)');
          process.exit(1);
        }
        skipToStep = parseInt(args[i]);
        if (isNaN(skipToStep) || skipToStep < 1 || skipToStep > 9) {
          console.error('Error: skip-to-step must be 1-9');
          process.exit(1);
        }
        break;
      case '-m':
        i++;
        if (i >= args.length) {
          console.error('Error: -m requires a model name');
          process.exit(1);
        }
        model = args[i];
        break;
      default:
        console.error(`Error: unknown option '${arg}'`);
        console.error('Usage: npx slapslap <video-file> [language] [-d] [-s <step>] [-m <model>]');
        console.error('  video-file   Input video file');
        console.error('  language     Target language (default: russian)');
        console.error('  -d           Dub mode: skip adding muted original voice (step 9)');
        console.error('  -s <step>    Skip to step (1-9)');
        console.error('  -m <model>   LLM model to use (default: qwen/qwen3.6-35b-a3b)');
        process.exit(1);
    }
    i++;
  }

  return { videoFile, language, skipToStep, dubOnly, model };
}

const { videoFile: INPUT_VIDEO, language: LANGUAGE, skipToStep: SKIP_TO_STEP, dubOnly, model} = parseArgs();

if (!INPUT_VIDEO) {
  console.error('Usage: npx slapslap <video-file> [language] [-d] [-s <step>]');
  process.exit(1);
}

// step 0 = run all steps
const SKIP_TO_STEP_FINAL = SKIP_TO_STEP || 0;
const TRANSLATE_LANGUAGE = LANGUAGE ?? 'russian';
const VOICEOVER_LANGUAGE = LANGUAGE ?? 'russian';

const LMSTUDIO_API_URL = 'http://localhost:1234';
const LMSTUDIO_V1_API = `${LMSTUDIO_API_URL}/api/v1`;
const LMSTUDIO_MODEL = process.env.LM_MODEL || 'qwen/qwen3.6-35b-a3b';
const LM_API_TOKEN = process.env.LM_API_TOKEN ?? 'none';
const DEVICE = process.env.DEVICE ?? 'cuda'; // 'cuda' or 'cpu'

const MIN_SILENCE_CUT = 1.0;
const SILENCE_NOISE_DB = -25;
const VOLUME_MIN_DB = -40;
const MIN_PART_SECONDS = 0.1;
const PADDING_SECONDS = 0.1;
const MAX_PART_SECONDS = 13;

function getLMStudioHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (LM_API_TOKEN) {
    headers['Authorization'] = `Bearer ${LM_API_TOKEN}`;
  }
  return headers;
}

async function loadLMStudioModel(modelKey) {
  console.log(`\n=== Loading model: ${modelKey} ===`);
  const response = await fetch(`${LMSTUDIO_V1_API}/models/load`, {
    method: 'POST',
    headers: getLMStudioHeaders(),
    body: JSON.stringify({
      model: modelKey,
      context_length: 16384,
      flash_attention: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to load model: ${error}`);
  }

  const data = await response.json();
  console.log(`Model loaded: ${data.instance_id}`);
  return data.instance_id;
}

async function unloadLMStudioModel(instanceId) {
  console.log(`\n=== Unloading model: ${instanceId} ===`);
  const response = await fetch(`${LMSTUDIO_V1_API}/models/unload`, {
    method: 'POST',
    headers: getLMStudioHeaders(),
    body: JSON.stringify({
      instance_id: instanceId
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to unload model: ${error}`);
  }

  console.log('Model unloaded');
}

const WORK_DIR = path.join(__dirname, 'work');
const AUDIO_DIR = path.join(WORK_DIR, 'audio');
const PARTS_DIR = path.join(WORK_DIR, 'parts');
const TRANS_DIR = path.join(WORK_DIR, 'translated');
const PARTS_JSON = path.join(WORK_DIR, 'parts.json');

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

const voiceFile = path.join(AUDIO_DIR, 'voice.wav');
const tempVoiceFile = path.join(AUDIO_DIR, '_voice.wav');
const noVoiceFile = path.join(AUDIO_DIR, 'no_voice.wav');
const translatedVoiceFile = path.join(AUDIO_DIR, 'translated_voice.wav');
const combinedAudio = path.join(AUDIO_DIR, 'combined.wav');

let parts = [];

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function parseTime(timeStr) {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

function loadParts() {
  if (fs.existsSync(PARTS_JSON)) {
    parts = JSON.parse(fs.readFileSync(PARTS_JSON, 'utf8'));
    console.log(`Loaded ${parts.length} parts from parts.json`);
    return true;
  }
  return false;
}

function saveParts() {
  fs.writeFileSync(PARTS_JSON, JSON.stringify(parts, null, 2));
  console.log(`Saved ${parts.length} parts to parts.json`);
}

async function step1_extractAudio() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log('\n=== Step 1: Extract audio from video ===');
  run(`ffmpeg -i "${INPUT_VIDEO}" -vn -acodec pcm_s16le -ar 44100 -ac 2 "${tempVoiceFile}" -y`);

  await step1b_separateAudio();
}

async function step1b_separateAudio() {
  console.log('\n=== Step 1b: Separate voice and background (Demucs) ===');

  const input = tempVoiceFile; // твой исходный extracted audio
  const outDir = path.join(AUDIO_DIR, 'demucs');

  const python =
    process.platform === 'win32'
        ? 'venv-ml\\Scripts\\python.exe'
        : './venv-ml/bin/python';

  const cmd = `${python} -m demucs --device ${DEVICE} --two-stems=vocals --float32 -o "${outDir}" "${input}"`;
  run(cmd);
  // run(`demucs --device ${DEVICE} --two-stems=vocals --float32 -o "${outDir}" "${input}"`);

  const base = path.basename(input, path.extname(input));
  const demucsFolder = path.join(outDir, 'htdemucs', base);

  const vocals = path.join(demucsFolder, 'vocals.wav');
  const noVocals = path.join(demucsFolder, 'no_vocals.wav');

  if (!fs.existsSync(vocals)) throw new Error('Demucs vocals not found');

  fs.copyFileSync(vocals, voiceFile);
  fs.copyFileSync(noVocals, noVoiceFile);

  console.log('Voice and background separated');
}

function mergeSegmentsToSentences(segments) {
  const merged = [];
  let id = 0;

  const allWords = [];

  for (const seg of segments) {
    for (const w of seg.words || []) {
      allWords.push(w);
    }
  }

  const isSentenceEnd = (word) =>
    /[.!?]["']?$/.test(word);

  // short pause between phrases/speakers should also split
  const PAUSE_THRESHOLD = 0.75;

  let currentWords = [];
  let currentStart = null;

  const flush = (endTime) => {
    if (!currentWords.length) return;
    merged.push({
      id: id++,
      seek: 0,
      start: currentStart,
      end: endTime,
      text: currentWords.map(x => x.word).join('').trim(),
      words: currentWords.slice()
    });
    currentWords = [];
    currentStart = null;
  };

  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    const cleanWord = w.word.trim();
    const nextWord = allWords[i + 1];

    if (!currentWords.length) {
      currentStart = w.start;
    }

    currentWords.push(w);

    const isEndByPunctuation = isSentenceEnd(cleanWord);

    const isEndByPause =
      nextWord && (nextWord.start - w.end > PAUSE_THRESHOLD);

    if ((isEndByPunctuation || isEndByPause) && nextWord) {
      // 🔑 gap-based extension (your previous improvement)
      const gap = nextWord.start - w.end;
      const extension = Math.min(gap / 2, 0.2);
      flush(w.end + extension);
    }
  }

  // leftover
  if (currentWords.length) {
    flush(currentWords[currentWords.length - 1].end);
  }

  return merged;
}

// Split an over-long sentence at natural semantic boundaries using the LLM,
// falling back to a deterministic word-boundary cut if the LLM is unavailable.
// Every returned part is guaranteed to be <= MAX_PART_SECONDS (TTS safety).
async function splitLongSentenceWithLLM(sentence) {
  const words = sentence.words || [];
  const maxDur = MAX_PART_SECONDS;

  const duration = words.length
    ? words[words.length - 1].end - words[0].start
    : sentence.end - sentence.start;

  if (duration <= maxDur) return [sentence];
  if (!sentence.text.trim()) return cutByWordBoundaries(sentence, maxDur);

  try {
    const llmParts = await llmFindSentenceSplits(sentence.text);
    let mapped = mapLlmPartsToWords(llmParts, words);
    let method = 'exact';
    if (!mapped) {
      mapped = mapLlmPartsProportional(llmParts, words);
      method = 'proportional';
    }
    if (mapped && mapped.length > 1) {
      const result = [];
      for (const sub of mapped) {
        if (sub.end - sub.start > maxDur) {
          result.push(...cutByWordBoundaries(sub, maxDur));
        } else {
          result.push(sub);
        }
      }
      if (result.length) {
        console.log(`  LLM split (${method}) into ${result.length} parts: "${sentence.text}"`);
        return result;
      }
    }
  } catch (e) {
    console.warn(`  LLM split failed for "${sentence.text}": ${e.message}`);
  }

  console.warn(`  Using duration-based fallback split for: "${sentence.text}"`);
  return cutByWordBoundaries(sentence, maxDur);
}

async function llmFindSentenceSplits(text) {
  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LMSTUDIO_MODEL,
      messages: [
        {
          role: 'user',
          content: `The text below is a single long sentence from a video. It is too long to be processed as one dubbing part, so split it into the smallest number of natural parts (usually 2-3) at real semantic boundaries (after clauses, commas, conjunctions like and/but/because, etc.) so each part keeps its meaning and the parts join back together without losing sense.
          If there are no good semantic boundaries, split at most logical place so that no part exceeds ${MAX_PART_SECONDS} seconds of speech.

Strict rules:
- Keep every word and punctuation EXACTLY as in the original. Do not add, remove, reorder or rephrase anything.
- Never cut in the middle of a clause or right after a single word.
- Keep the parts in the same order as the original.
- Each part must be a natural, self-contained chunk.
- Return ONLY a JSON array of the parts as strings, nothing else.

Text:
${text}`
        }
      ],
      temperature: 0,
      max_tokens: Math.min(Math.ceil(text.length * 2), 4096),
      stop: ["<think>"],
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array in response');

  const parsed = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Response is not an array');

  return parsed.filter(p => typeof p === 'string' && p.trim());
}

// Map the LLM-split text parts back to the original word timestamps.
// Returns null unless EVERY original word is covered exactly once
// (any dropped/rephrased word makes the caller fall back to a safe cut).
function mapLlmPartsToWords(llmParts, words) {
  if (!llmParts.length || !words.length) return null;

  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const normWords = words.map(w => norm(w.word));

  const result = [];
  let k = 0;
  let covered = 0;

  for (const part of llmParts) {
    const partNorms = part.split(/\s+/).map(norm).filter(Boolean);
    if (!partNorms.length) continue;

    let bestStart = -1;
    let bestLen = 0;
    for (let s = k; s < normWords.length; s++) {
      let len = 0;
      while (s + len < normWords.length && len < partNorms.length && normWords[s + len] === partNorms[len]) {
        len++;
      }
      if (len > bestLen) {
        bestLen = len;
        bestStart = s;
        if (len === partNorms.length) break;
      }
    }

    if (bestLen === 0) return null;

    const rangeWords = words.slice(bestStart, bestStart + bestLen);
    result.push({
      start: rangeWords[0].start,
      end: rangeWords[rangeWords.length - 1].end,
      text: rangeWords.map(x => x.word).join('').trim(),
      words: rangeWords
    });
    covered += bestLen;
    k = bestStart + bestLen;
  }

  if (covered !== normWords.length) return null;

  return result;
}

// Fallback mapping: place LLM chunk boundaries by the chunks' relative word
// counts, snapped to the original word boundaries. Covers every original word
// exactly once, so content is never lost even if the LLM rephrased some words.
function mapLlmPartsProportional(llmParts, words) {
  if (!llmParts.length || !words.length) return null;

  const countWords = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean).length;
  const counts = llmParts.map(countWords);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;

  const N = words.length;
  const result = [];
  let startIdx = 0;
  let cum = 0;

  for (let i = 0; i < counts.length; i++) {
    cum += counts[i];
    let endIdx;
    if (i === counts.length - 1) {
      endIdx = N;
    } else {
      const remainingParts = counts.length - 1 - i;
      endIdx = Math.max(startIdx + 1, Math.min(N - remainingParts, Math.round(cum * N / total)));
    }

    const rangeWords = words.slice(startIdx, endIdx);
    result.push({
      start: rangeWords[0].start,
      end: rangeWords[rangeWords.length - 1].end,
      text: rangeWords.map(x => x.word).join('').trim(),
      words: rangeWords
    });
    startIdx = endIdx;
  }

  return result;
}

// Deterministic fallback: cut at word boundaries so no part exceeds maxDur.
function cutByWordBoundaries(sentence, maxDur) {
  if (!sentence.words || !sentence.words.length) return [sentence];

  const parts = [];
  let cur = [];
  let curStart = null;

  for (const w of sentence.words) {
    if (!cur.length) curStart = w.start;
    if (cur.length && w.end - curStart > maxDur) {
      const range = cur;
      parts.push({
        start: curStart,
        end: range[range.length - 1].end,
        text: range.map(x => x.word).join('').trim(),
        words: range.slice()
      });
      cur = [];
      curStart = w.start;
    }
    cur.push(w);
  }

  if (cur.length) {
    parts.push({
      start: curStart,
      end: cur[cur.length - 1].end,
      text: cur.map(x => x.word).join('').trim(),
      words: cur.slice()
    });
  }

  return parts;
}

async function step2_splitBySilence() {
  console.log('\n=== Step 2: Split voice track by silence ===');
  if (!fs.existsSync(voiceFile)) throw new Error('voice.wav not found');

  const duration = getDuration(voiceFile);
  if (!duration) throw new Error('Failed to get voice.wav duration');

  const probeCmd = `ffmpeg -i "${voiceFile}" -af silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${MIN_SILENCE_CUT} -f null - 2>&1`;
  console.log(`> ${probeCmd}`);
  const out = execSync(probeCmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).toString();

  const events = [];
  let m;
  const startRe = /silence_start:\s*([\d.]+)/g;
  while ((m = startRe.exec(out)) !== null) events.push({ time: parseFloat(m[1]), type: 'start' });
  const endRe = /silence_end:\s*([\d.]+)/g;
  while ((m = endRe.exec(out)) !== null) events.push({ time: parseFloat(m[1]), type: 'end' });
  events.sort((a, b) => a.time - b.time);

  const candidates = [];
  let cursor = 0;
  for (const ev of events) {
    if (ev.type === 'start') {
      if (ev.time > cursor + 1e-9) candidates.push({ start: cursor, end: ev.time });
      cursor = ev.time;
    } else {
      cursor = Math.max(cursor, ev.time);
    }
  }
  if (duration > cursor + 1e-9) candidates.push({ start: cursor, end: duration });

  console.log(`Detected ${candidates.length} candidate voice intervals`);

  const kept = [];
  for (const c of candidates) {
    const volCmd = `ffmpeg -ss ${c.start} -t ${c.end - c.start} -i "${voiceFile}" -af volumedetect -f null - 2>&1`;
    console.log(`> ${volCmd}`);
    const volOut = execSync(volCmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).toString();
    const volMatches = [...volOut.matchAll(/mean_volume:\s*(-?[\d.]+) dB/g)].map(mm => parseFloat(mm[1]));
    const meanVolume = volMatches.length ? Math.max(...volMatches) : -Infinity;
    if (meanVolume < VOLUME_MIN_DB) {
      console.log(`  Drop (quiet): ${c.start.toFixed(2)}s-${c.end.toFixed(2)}s (${meanVolume.toFixed(1)} dB)`);
      continue;
    }
    if (c.end - c.start < MIN_PART_SECONDS) {
      console.log(`  Drop (short): ${c.start.toFixed(2)}s-${c.end.toFixed(2)}s`);
      continue;
    }
    kept.push(c);
  }

  parts = kept.map(c => ({
    start: c.start,
    end: c.end,
    text: '',
    translated: '',
    file: ''
  }));

  if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const filename = `part_${String(i).padStart(3, '0')}.wav`;
    p.file = path.join(PARTS_DIR, filename);
    const cutStart = Math.max(0, p.start - PADDING_SECONDS);
    const cutEnd = Math.min(duration, p.end + PADDING_SECONDS);
    console.log(`  Cut: ${filename} (${p.start.toFixed(2)}s - ${p.end.toFixed(2)}s)`);
    run(`ffmpeg -i "${voiceFile}" -ss ${cutStart} -to ${cutEnd} -c copy "${p.file}" -y`);
  }
  saveParts();
}

async function step3_transcribeParts() {
  console.log('\n=== Step 3: Transcribe each voice part ===');
  if (!loadParts()) throw new Error('No parts.json (run step 2 first)');

  const python =
    process.platform === 'win32'
        ? 'set PYTHONWARNINGS=ignore && set PYTHONIOENCODING=utf-8 && venv-ml\\Scripts\\python.exe'
        : 'PYTHONWARNINGS=ignore PYTHONIOENCODING=utf-8 ./venv-ml/bin/python';

  const duration = getDuration(voiceFile);
  const finalParts = [];

  for (const p of parts) {
    if (!p.file || !fs.existsSync(p.file)) throw new Error(`Missing part file: ${p.file}`);

    const baseName = path.basename(p.file, path.extname(p.file));
    const partDir = path.join(WORK_DIR, `whisper_${baseName}`);
    if (!fs.existsSync(partDir)) fs.mkdirSync(partDir, { recursive: true });

    const cmd = `${python} -m whisper "${p.file}" --model large-v3 --output_format json --output_dir "${partDir}" --word_timestamps True --condition_on_previous_text False`;
    run(cmd);

    const jsonFile = path.join(partDir, `${baseName}.json`);
    if (!fs.existsSync(jsonFile)) throw new Error(`Whisper JSON not found: ${jsonFile}`);

    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

    const words = [];
    for (const seg of data.segments || []) {
      for (const w of seg.words || []) {
        words.push({ start: w.start + p.start, end: w.end + p.start, word: w.word });
      }
    }

    p.text = words.map(w => w.word).join('').trim();

    let newParts = [p];
    if (words.length) {
      const sentences = mergeSegmentsToSentences([{ words }]);
      if (sentences.length) newParts = sentences;
    }

    for (const s of newParts) {
      const part = { start: s.start, end: s.end, text: s.text, translated: '', file: '' };
      // keep whisper word timestamps only for parts that step 4 may split further
      if (s.words && s.words.length) {
        const dur = s.words[s.words.length - 1].end - s.words[0].start;
        if (dur > MAX_PART_SECONDS) part.words = s.words;
      }
      finalParts.push(part);
    }
  }

  parts = finalParts;

  if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const filename = `part_${String(i).padStart(3, '0')}.wav`;
    p.file = path.join(PARTS_DIR, filename);
    const cutStart = Math.max(0, p.start - PADDING_SECONDS);
    const cutEnd = duration ? Math.min(duration, p.end + PADDING_SECONDS) : p.end + PADDING_SECONDS;
    console.log(`  Cut: ${filename} (${p.start.toFixed(2)}s - ${p.end.toFixed(2)}s)`);
    run(`ffmpeg -i "${voiceFile}" -ss ${cutStart} -to ${cutEnd} -c copy "${p.file}" -y`);
  }
  saveParts();
}

async function step4_splitLongSentences() {
  if (!loadParts()) throw new Error('No parts.json (run step 3 first)');

  console.log('\n=== Step 4: Split long sentences with LLM ===');

  const voiceDuration = getDuration(voiceFile);
  if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });

  const newParts = [];

  for (const p of parts) {
    const dur = p.words && p.words.length
      ? p.words[p.words.length - 1].end - p.words[0].start
      : p.end - p.start;

    if (dur <= MAX_PART_SECONDS) {
      delete p.words;
      newParts.push(p);
      continue;
    }

    if (!p.words || !p.words.length) {
      console.warn(`  WARNING: part ${path.basename(p.file)} (${dur.toFixed(1)}s) has no word timestamps, keeping as-is`);
      newParts.push(p);
      continue;
    }

    const subs = await splitLongSentenceWithLLM({ start: p.start, end: p.end, text: p.text, words: p.words });

    if (subs.length === 1) {
      newParts.push(p);
      continue;
    }

    const base = path.basename(p.file, path.extname(p.file));
    for (let si = 0; si < subs.length; si++) {
      const sub = subs[si];
      const filename = `${base}_${si}.wav`;
      const cutStart = Math.max(0, sub.start - PADDING_SECONDS);
      const cutEnd = voiceDuration ? Math.min(voiceDuration, sub.end + PADDING_SECONDS) : sub.end + PADDING_SECONDS;
      console.log(`  Cut: ${filename} (${sub.start.toFixed(2)}s - ${sub.end.toFixed(2)}s)`);
      run(`ffmpeg -i "${voiceFile}" -ss ${cutStart} -to ${cutEnd} -c copy "${path.join(PARTS_DIR, filename)}" -y`);
      newParts.push({ start: sub.start, end: sub.end, text: sub.text, translated: '', file: path.join(PARTS_DIR, filename) });
    }
  }

  parts = newParts;
  saveParts();
}

// Make corrections to this text and restore it as good as possible.
const rules = `You are professional translator, your task is to translate text.
Keep same style for translation as in original so not only words are translated but also sence and emotion and style of speech are preserved.
Write numbers as text.
THIS IS IMPORTANT: Do not write numbers as numbers "с 2017 года" should be "с две тысячи семнадцатого года"!
This translation will be used for dub voiceover so try to keep length very similar to original (not text length but audio length) adapt translation or rephrase if needed.
IMPORTANT: Do not translate names and titles.
Do not translate technical terms that you dont understand meaning in current context.
Use words instead of numbers like "четвёртое июля" and not "4 июля".
Translation should not be longer than original text or voicover will be out of sync.`;

async function translateWithLLM(text, context, duration) {
  try {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        messages: [
          {
            role: 'user',
            content: `
            rules: ${rules}

            Here are previous phrases of the conversation with their translations so you understand the context:

            ${context || '(no previous context yet)'}

            Original voice duration for current part is: ${duration} seconds.
            Try to keep translation duration and amount of syllables similar by adapting translation if needed.
            Do not make translation longer or with more syllables than original, if it's longer, adapt it or rephrase to fit duration.

            Translate this part of text to ${TRANSLATE_LANGUAGE}. Output only translation AND ONLY FOR THIS PART and nothing else. IMPORTANT: translate only this part! Translation should not be longer than original text. If you add something from context except this part, I will put you in jail!
            
			Return only translation and nothing else!
			Translate ONLY this text: '${text}'`
          }
        ],

        temperature: 0,
        max_tokens: Math.ceil(text.length / 2),
        stop: ["\n", "<think>"],
        chat_template_kwargs: { enable_thinking: false }
      })
    });

    const data = await response.json();

    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Translation failed:', error.message);
    return text;
  }
}

async function doubleCheckWithLLM(text, translation) {
  try {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        messages: [
          {
            role: 'user',
            content: `I have a script that cut translated text and make pairs of original and translated text parts.
            This script sometimes fails and cut in wrong place so extra part of text is in translation.
            Your task is to double-check the translation and ensure it does not contain any extra text.
            Please return only the translation without extra text and without any explanations.
            Don't change or rephrase translation, just remove extra text if it is there.
            There are chance that script cuts totally wrong part of text, in this case please translate original text.
            But PLEASE, do not change normally translated text! If it's not totally wrong part and don't have extra text, just return it as is.
			
			Original text: "${text}".
            Translated to ${TRANSLATE_LANGUAGE} text: "${translation}".`
          }
        ],

        temperature: 0,
        max_tokens: Math.ceil(text.length / 2),
        stop: ["\n", "<think>"],
        chat_template_kwargs: { enable_thinking: false }
      })
    });

    const data = await response.json();

    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Double check failed:', error.message);
    return text;
  }
}

async function step5_translate() {
  if (!loadParts()) throw new Error('No parts.json');

  console.log(`\n=== Step 5: Translate ${parts.length} parts ===`);

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.translated) continue;

    const context = parts
      .slice(0, i)
      .filter(prev => prev.text && prev.translated)
      .map(prev => `"${prev.text}" : "${prev.translated}"`)
      .join('\n');

    console.log(`O:  ${p.text}`);

    p.translated = await translateWithLLM(p.text, context, (p.end - p.start).toFixed(2));
    
    console.log(`T:  ${p.translated}`);

    // p.translated = await doubleCheckWithLLM(p.text, p.translated);

    // console.log(`D:  ${p.translated}`);
  }

  saveParts();
}

async function step6_generateAudio() {
  if (!loadParts()) throw new Error('No parts.json');
  if (!fs.existsSync(TRANS_DIR)) fs.mkdirSync(TRANS_DIR, { recursive: true });
  console.log('\n=== Step 6: Generate translated audio ===');
  for (const p of parts) {
    const out = path.join(TRANS_DIR, path.basename(p.file));
    const duration = Math.ceil(p.end - p.start);
    const textEscaped = p.translated.replace(/"/g, '\\"');
    const refTextEscaped = p.text.replace(/"/g, '\\"'); //  --ref-text="${refTextEscaped}"
    
  const generate_audio =
    process.platform === 'win32'
        ? 'generate_audio'
        : './generate_audio';

    const cmd = `${generate_audio} --model-dir models/base-1.7b --text="${textEscaped}" --ref-audio "${p.file}" --language ${VOICEOVER_LANGUAGE} --output "${out}" --duration ${duration * 1.5} --repetition-penalty 2`;
    console.log(`  Generating (${duration}s): ${p.translated}`);
    run(cmd);
  }
}

function getDuration(file) {
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString().trim();
    return parseFloat(out);
  } catch (e) {
    console.error(`Failed to get duration for ${file}:`, e.message);
    return null;
  }
}

async function step7_joinAudio() {
  if (!loadParts()) throw new Error('No parts.json');

  const validParts = [];

  for (const p of parts) {
    const translatedFile = path.resolve(TRANS_DIR, path.basename(p.file));

    if (!fs.existsSync(translatedFile)) {
      console.warn(`  WARNING: Missing translated file for ${path.basename(p.file)}`);
      continue;
    }

    validParts.push({ ...p, translatedFile });
  }

  if (validParts.length === 0) throw new Error('No translated audio files found');

  console.log(`\n=== Step 7: Join translated audio (${validParts.length} parts) ===`);

  const args = [];
  const filterChains = [];
  const partLabels = [];

  const sortedParts = [...validParts].sort((a, b) => a.start - b.start);

  let inputIdx = 0;

  for (const p of sortedParts) {
    const translatedDuration = getDuration(p.translatedFile);

  if (!translatedDuration) {
    console.warn(`  WARNING: Could not read duration for ${path.basename(p.translatedFile)}, skipping`);
    continue;
  }

  args.push('-i', p.translatedFile);

  // соседние части
  const idx = sortedParts.indexOf(p);
  const prevPart = idx > 0 ? sortedParts[idx - 1] : null;
  const nextPart = idx < sortedParts.length - 1 ? sortedParts[idx + 1] : null;

  // оригинальное окно
  const originalStart = p.start;
  const originalEnd = p.end;
  const originalDuration = originalEnd - originalStart;

  // доступные промежутки
  const gapBefore = prevPart
    ? Math.max(0, originalStart - prevPart.end)
    : 0;

  const gapAfter = nextPart
    ? Math.max(0, nextPart.start - originalEnd)
    : 0;

  // можно использовать максимум половину промежутков
  const maxExtendBefore = gapBefore * 0.5;
  const maxExtendAfter = gapAfter * 0.5;

  // насколько перевод длиннее оригинала
  const overflow = Math.max(0, translatedDuration - originalDuration);

  // насколько нужно расширить окно
  // распределяем расширение симметрично
  const desiredExtendBefore = Math.min(
    maxExtendBefore,
    overflow * 0.5
  );

  const desiredExtendAfter = Math.min(
    maxExtendAfter,
    overflow * 0.5
  );

  // итоговое окно
  const targetStart = originalStart - desiredExtendBefore;
  const targetEnd = originalEnd + desiredExtendAfter;

  const availableDuration = targetEnd - targetStart;

  // коэффициент speed
  // стараемся вообще не ускорять,
  // пока помещаемся
  let speed = translatedDuration / availableDuration;

  // ограничения для естественности
  const MIN_SPEED = 1; // не замедляем, чтобы не звучало странно
  const MAX_SPEED = 2; // не ускоряем слишком сильно, чтобы не звучало странно

  // если ускорение небольшое — лучше оставить 1x
  if (speed <= 1.03) {
    speed = 1;
  }

  // clamp
  speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));

  // если даже после overlap не влезает,
  // слегка ускоряем
  const finalDuration = translatedDuration / speed;

  // центрируем внутри доступного окна
  const freeSpace = Math.max(0, availableDuration - finalDuration);

  const startTime =
    targetStart + freeSpace * 0.5;

  const startMs = Math.round(startTime * 1000);

  console.log({
    file: path.basename(p.translatedFile),

    translatedDuration,
    originalDuration,

    gapBefore,
    gapAfter,

    desiredExtendBefore,
    desiredExtendAfter,

    availableDuration,

    speed,
    startTime
  });

  const atempoFilters = [];

  if (Math.abs(speed - 1) > 0.01) {
    atempoFilters.push(`atempo=${speed.toFixed(4)}`);
  }

  const adelayFilter = `adelay=${startMs}|${startMs}`;

  const filter =
    atempoFilters.length > 0
      ? `${atempoFilters.join(',')},${adelayFilter}`
      : adelayFilter;

  const filterChain =
    `[${inputIdx}:a]${filter}[part${inputIdx}]`;

  filterChains.push(filterChain);
  partLabels.push(`[part${inputIdx}]`);

    inputIdx++;
  }

  if (partLabels.length === 0) throw new Error('No valid parts to join');

  const mixFilter =
    `${partLabels.join('')}amix=inputs=${partLabels.length}:normalize=0:duration=longest[out]`;

  filterChains.push(mixFilter);

  const filterComplex = filterChains.join(';');

  const scriptFile = path.join(WORK_DIR, 'filter_complex.txt');

  fs.writeFileSync(scriptFile, filterComplex);

  args.push(
    '-filter_complex_script', scriptFile,
    '-map', '[out]',
    '-y',
    translatedVoiceFile
  );

  console.log(`  Joining ${partLabels.length} parts...`);

  await runFFmpeg(args);
}

async function step8_mixVoiceWithBackground() {
  console.log('\n=== Step 8: Mix translated voice with background ===');

  const output = combinedAudio;

  const args = [
    '-i', noVoiceFile,          // фон
    '-i', translatedVoiceFile,  // твой голос
    '-filter_complex',
    `
    [0:a]volume=1.0[bg];
    [1:a]volume=1.5[voice];
    [bg][voice]amix=inputs=2:duration=longest:normalize=0[out]
    `,
    '-map', '[out]',
    '-y',
    output
  ];

  await runFFmpeg(args);
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, {
      stdio: 'inherit' // чтобы видеть лог ffmpeg
    });

    ff.on('error', reject);

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

/* async function step9_makeVideo() {
  const outputVideo = path.join(__dirname, TRANSLATE_LANGUAGE + '_' + path.basename(INPUT_VIDEO));
  console.log('\n=== Step 9: Create video ===');
  run(`ffmpeg -i "${INPUT_VIDEO}" -i "${combinedAudio}" -map 0:v -map 1:a -c:v copy -shortest "${outputVideo}" -y`);
  console.log(`Done! ${outputVideo}`);
} */

async function step9_makeVideo() {
  const outputVideo = path.join(__dirname, TRANSLATE_LANGUAGE + '_' + path.basename(INPUT_VIDEO));
  console.log('\n=== Step 9: Create video ===');

  if (dubOnly) {
    console.log('  Dub mode: using translated audio without original voice overlay');
    const args = [
      '-i', INPUT_VIDEO,
      '-i', combinedAudio,
      '-map', '0:v',
      '-map', '1:a',
      '-c:v', 'copy',
      '-shortest',
      '-y',
      outputVideo
    ];
    await runFFmpeg(args);
  } else {
    console.log('  Adding quiet original voice overlay');
    const args = [
      '-i', INPUT_VIDEO,
      '-i', combinedAudio,
      '-i', voiceFile,
      '-filter_complex',
      `
      [1:a]volume=1.0[translated];
      [2:a]volume=0.2[orig]; 
      [translated][orig]amix=inputs=2:duration=longest:normalize=0[mix]
      `,
      '-map', '0:v',
      '-map', '[mix]',
      '-c:v', 'copy',
      '-shortest',
      '-y',
      outputVideo
    ];
    await runFFmpeg(args);
  }

  console.log(`Done! ${outputVideo}`);
}

async function main() {
  let loadedModelId = null;
  try {
    if (SKIP_TO_STEP_FINAL <= 1) await step1_extractAudio();
    if (SKIP_TO_STEP_FINAL <= 2) await step2_splitBySilence();
    if (SKIP_TO_STEP_FINAL <= 3) await step3_transcribeParts();

    if (SKIP_TO_STEP_FINAL <= 4) {
      loadedModelId = await loadLMStudioModel(LMSTUDIO_MODEL);
      try {
        await step4_splitLongSentences();
      } finally {
        if (loadedModelId) {
          await unloadLMStudioModel(loadedModelId);
          loadedModelId = null;
        }
      }
    }

    if (SKIP_TO_STEP <= 5) {
      loadedModelId = await loadLMStudioModel(LMSTUDIO_MODEL);
      try {
        await step5_translate();
      } finally {
        if (loadedModelId) {
          await unloadLMStudioModel(loadedModelId);
          loadedModelId = null;
        }
      }
    }

    if (SKIP_TO_STEP_FINAL <= 6) await step6_generateAudio();
    if (SKIP_TO_STEP_FINAL <= 7) await step7_joinAudio();
    if (SKIP_TO_STEP_FINAL <= 8) await step8_mixVoiceWithBackground();
    if (SKIP_TO_STEP_FINAL <= 9) await step9_makeVideo();
  } catch (e) {
    console.error('Error:', e.message);
    if (loadedModelId) {
      try {
        await unloadLMStudioModel(loadedModelId);
      } catch (unloadError) {
        console.error('Failed to unload model:', unloadError.message);
      }
    }
    process.exit(1);
  }
}

main();
