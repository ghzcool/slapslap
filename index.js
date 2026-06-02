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
      default:
        console.error(`Error: unknown option '${arg}'`);
        console.error('Usage: npx slapslap <video-file> [language] [-d] [-s <step>]');
        console.error('  video-file   Input video file');
        console.error('  language     Target language (default: russian)');
        console.error('  -d           Dub mode: skip adding muted original voice (step 9)');
        console.error('  -s <step>    Skip to step (1-9)');
        process.exit(1);
    }
    i++;
  }

  return { videoFile, language, skipToStep, dubOnly };
}

const { videoFile: INPUT_VIDEO, language: LANGUAGE, skipToStep: SKIP_TO_STEP, dubOnly } = parseArgs();

if (!INPUT_VIDEO) {
  console.error('Usage: npx slapslap <video-file> [language] [-d] [-s <step>]');
  process.exit(1);
}

// step 0 = run all steps
const SKIP_TO_STEP_FINAL = SKIP_TO_STEP || 0;
const TRANSLATE_LANGUAGE = LANGUAGE ?? 'russian';
const VOICEOVER_LANGUAGE = LANGUAGE ?? 'russian';

const LMSTUDIO_API_URL = 'http://localhost:1234'; // 'http://10.100.1.77:1234'; //
const LMSTUDIO_V1_API = `${LMSTUDIO_API_URL}/api/v1`;
const LMSTUDIO_MODEL = process.env.LM_MODEL || 'qwen/qwen3.5-9b';
const LMSTUDIO_MODEL_LARGE = process.env.LM_MODEL_LARGE || 'qwen/qwen3.6-35b-a3b';
const LM_API_TOKEN = process.env.LM_API_TOKEN ?? 'none';

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
const textFile = path.join(WORK_DIR, 'voice.json');
const transcriptFile = path.join(WORK_DIR, 'transcript.json');

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

  run(`venv-ml\\Scripts\\python -m demucs --device cuda --two-stems=vocals --float32 -o "${outDir}" "${input}"`);
  // run(`demucs --device cuda --two-stems=vocals --float32 -o "${outDir}" "${input}"`);

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

  let currentWords = [];
  let currentStart = null;

  const PAUSE_THRESHOLD = 2;

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

      const isTooLong = (w.end - currentStart > 15); // hard limit to avoid very long sentences

    const shouldSplit =
      (isEndByPunctuation || isEndByPause || isTooLong) && nextWord;

    if (shouldSplit) {
      const sentenceEndTime = w.end;

      // 🔑 gap-based extension (your previous improvement)
      const gap = nextWord.start - sentenceEndTime;
      let extension = Math.min(gap / 2, 0.2);

      const sentenceText = currentWords.map(x => x.word).join('').trim();

      merged.push({
        id: id++,
        seek: 0,
        start: currentStart,
        end: sentenceEndTime + extension,
        text: sentenceText
      });

      currentWords = [];
      currentStart = null;
    }
  }

  // leftover
  if (currentWords.length) {
    merged.push({
      id: id++,
      seek: 0,
      start: currentStart,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map(x => x.word).join('').trim()
    });
  }

  return merged;
}

async function step2_speechToText() {
  console.log('\n=== Step 2: Speech to text ==='); // small medium large large-v3 large-v3-turbo
  run(`set PYTHONWARNINGS=ignore && venv-ml\\Scripts\\python -m whisper "${voiceFile}" --model large-v3 --output_format json --output_dir "${WORK_DIR}" --word_timestamps True`); // --language en
  if (fs.existsSync(textFile)) fs.renameSync(textFile, transcriptFile);
}

async function step3_parseTranscriptAndCut() {
  console.log('\n=== Step 3: Parse transcript and cut audio parts ===');
  if (!fs.existsSync(transcriptFile)) throw new Error('transcript.json not found');

  const data = JSON.parse(fs.readFileSync(transcriptFile, 'utf8'));

  if (!data.segments) throw new Error('transcript.json missing segments');

  const sentences = mergeSegmentsToSentences(data.segments);

  parts = sentences.map((sent, i) => ({
    start: sent.start,
    end: sent.end,
    text: sent.text,
    translated: '',
    file: ''
  })).filter(p => p.end - p.start > 0.3); // фильтр коротких частей

  if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const filename = `part_${String(i).padStart(3, '0')}.wav`;
    p.file = path.join(PARTS_DIR, filename);
    
    console.log(`  Cut: ${filename} (${p.start.toFixed(2)}s - ${p.end.toFixed(2)}s)`);
    run(`ffmpeg -i "${voiceFile}" -ss ${p.start} -to ${p.end} -c copy "${p.file}" -y`);
  }
  saveParts();
}
// Make corrections to this text and restore it as good as possible.
const rules = `This text is generated from speech recognition and may contain errors.
Keep same style for translation as in original so not only words are translated but also sence and emotion and style of speech are preserved.
Write numbers as text.
THIS IS IMPORTANT: Do not write numbers as numbers "с 2017 года" should be "с две тысячи семнадцатого года"!
This translation will be used for dub voiceover so keep length very similar to original (not text length but audio length) adapt translation or rephrase if needed.
IMPORTANT: Do not translate names and titles.
Do not translate technical terms that you dont understand in context.
Use words instead of numbers like "четвёртое июля" and not "4 июля".
Voice will be generated for this text.
Translation should not be longer than original text or voicover will be out of sync.`;

async function fetchStream(body) {
  const res = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'close'
    },
    body: JSON.stringify({
      ...body,
      stream: true
    })
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const decoder = new TextDecoder('utf-8');

  let result = '';
  let buffer = '';

  for await (const chunk of res.body) {
    // 🔥 decode Uint8Array correctly
    buffer += decoder.decode(chunk, { stream: true });

    // split complete SSE lines
    const lines = buffer.split('\n');

    // keep incomplete line for next chunk
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith('data:')) continue;

      const data = trimmed.replace(/^data:\s*/, '');

      if (data === '[DONE]') {
        return result.trim();
      }

      try {
        const json = JSON.parse(data);

        // OpenAI-compatible streaming format
        const token =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.text ??
          '';

        if (token) {
          process.stdout.write(token);
          result += token;
        }
      } catch (e) {
        // partial JSON can happen between chunks
      }
    }
  }

  return result.trim();
}

async function initContext(fullText) {
  return await fetchStream({
    model: LMSTUDIO_MODEL_LARGE,
      messages: [
        {
          role: 'system',
          content: 'rules: ' + rules
        },
        {
          role: 'system',
          content: 'Translate text to ' + TRANSLATE_LANGUAGE + '. Output only the translation, nothing else.'
        },
        {
          role: 'user',
          content: fullText
        }
      ],
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false }
  });
}

async function translateWithLLM(text, fullText, translatedFullText, duration) {
  try {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL_LARGE,
        messages: [
          {
            role: 'system',
            content: 'Here are full text so you understand context of translation: ' + fullText
          },
          {
            role: 'system',
            content: 'Here are full translated text so you understand context of translation: ' + translatedFullText
          },
          {
            role: 'system',
            content: 'rules: ' + rules
          },
          {
            role: 'system',
            content: `Original voice duration is: ${duration} seconds.
            Try to keep translation duration and amount of syllables similar by adapting translation if needed.
            Do not make translation longer or with more syllables than original, if it's longer, adapt it or rephrase to fit duration.`
          },
          {
            role: 'system',
            content: 'Translate this part of text to ' + TRANSLATE_LANGUAGE + '. Output only translation AND ONLY FOR THIS PART and nothing else. IMPORTANT: translate only this part! Translation should not be longer than original text. If you add something from full text except this part, I will put you in jail!'
          },
          {
            role: 'user',
            content: 'Translate ONLY this text: ' + text
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
        model: LMSTUDIO_MODEL_LARGE,
        messages: [
          {
            role: 'system',
            content: `I have a script that cut translated text and make pairs of original and translated text parts.
            This script sometimes fails and cut in wrong place so extra part of text is in translation.
            Your task is to double-check the translation and ensure it does not contain any extra text.
            Please return only the translation without extra text and without any explanations.
            Don't change or rephrase translation, just remove extra text if it is there.
            There are chance that script cuts totally wrong part of text, in this case please translate original text.
            But PLEASE, do not change normally translated text! If it's not totally wrong part and don't have extra text, just return it as is.`
          },
          {
            role: 'user',
            content: `Original text: "${text}".
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

  const fullText = parts.map(p => p.text).join('\n');

  console.log('Initializing context...');
  let translatedFullText;
  try {
    translatedFullText = await initContext(fullText);
  } catch (e) {
    console.error('Failed to initialize context (LLM may be unavailable):', e.message);
    console.error('Continuing without context — individual translations may be less accurate.');
    translatedFullText = '';
  }

  console.log(translatedFullText);

  for (const p of parts) {
    if (p.translated) continue;

    console.log(`O:  ${p.text}`);

    p.translated = await translateWithLLM(p.text, fullText, translatedFullText, (p.end - p.start).toFixed(2));
    
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
    const cmd = `generate_audio --model-dir models/base-1.7b --text="${textEscaped}" --ref-audio "${p.file}" --language ${VOICEOVER_LANGUAGE} --output "${out}" --duration ${duration * 2} --repetition-penalty 2`;
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

  const allWords = [];
  
  const data = JSON.parse(fs.readFileSync(transcriptFile, 'utf8'));

  if (!data.segments) throw new Error('transcript.json missing segments');
  for (const seg of data.segments) {
    for (const w of seg.words || []) {
      allWords.push(w);
    }
  }

  let inputIdx = 0;

  for (const p of validParts) {
    const translatedDuration = getDuration(p.translatedFile);

  if (!translatedDuration) {
    console.warn(`  WARNING: Could not read duration for ${path.basename(p.translatedFile)}, skipping`);
    continue;
  }

  args.push('-i', p.translatedFile);

  // соседние слова
  const nextWord = allWords.find(w => w.start > p.end);
  const prevWord = allWords.findLast(w => w.end < p.start);

  // оригинальное окно
  const originalStart = p.start;
  const originalEnd = p.end;
  const originalDuration = originalEnd - originalStart;

  // доступные промежутки
  const gapBefore = prevWord
    ? Math.max(0, originalStart - prevWord.end)
    : 0;

  const gapAfter = nextWord
    ? Math.max(0, nextWord.start - originalEnd)
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
    [1:a]volume=1.2[voice];
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
    if (SKIP_TO_STEP_FINAL <= 2) await step2_speechToText();
    if (SKIP_TO_STEP_FINAL <= 3) await step3_parseTranscriptAndCut();

    // Step 4 was removed from the pipeline

    if (SKIP_TO_STEP_FINAL <= 5) {
      loadedModelId = await loadLMStudioModel(LMSTUDIO_MODEL_LARGE);
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
