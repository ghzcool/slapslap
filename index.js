const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const INPUT_VIDEO = process.argv[2];
const LANGUAGE = process.argv[3];
const skipArg = process.argv[4];
let SKIP_TO_STEP = 0;

const TRANSLATE_LANGUAGE = LANGUAGE ?? 'russian';
const VOICEOVER_LANGUAGE = LANGUAGE ?? 'russian';

if (skipArg) {
  const parsed = parseInt(skipArg);
  if (isNaN(parsed) || parsed < 1 || parsed > 9) {
    console.error('Usage: node index.js <video-file> [language] [skip-to-step]');
    console.error('skip-to-step: 1-9, first step to run (default: 1, runs all)');
    process.exit(1);
  }
  SKIP_TO_STEP = parsed;
}

if (!INPUT_VIDEO) {
  console.error('Usage: node index.js <video-file> [language] [skip-to-step]');
  process.exit(1);
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
const textFile = path.join(__dirname, 'voice.json');
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

  const PAUSE_THRESHOLD = 3;

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

      const isTooLong = (w.end - currentStart > 20); // hard limit to avoid very long sentences

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
  run(`set PYTHONWARNINGS=ignore && whisper "${voiceFile}" --model large-v3-turbo --output_format json --word_timestamps True`); // --language en
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
  }));

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

const rules = 'This text is generated from speech recognition and may contain errors. Make corrections to this text and restore it as good as possible. Keep same style but write numbers as text. THIS IS IMPORTANT: Do not write numbers as numbers "с 2017 года" should be "с две тысячи семнадцатого года"! This translation will be used for dub voiceover so keep length very similar to original (not text length but audio length) adapt translation or rephrase if needed. Make it sound natural, like people say. IMPORTANT: Do not translate names and titles. Do not translate technical terms that you dont understand in context. Use words instead of numbers like "четвёртое июля" and not "4 июля". Voice will be generated for this text so please capitalize where stress should be in words.';

async function initContext(fullText) {
  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3',
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
      temperature: 0
    })
  });

  const data = await response.json();

  return data.choices[0].message.content.trim();
}

async function translateWithLLM(text, fullText, translatedFullText) {
  try {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3',

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
            content: 'Translate this part of text to ' + TRANSLATE_LANGUAGE + '. Output only translation AND ONLY FOR THIS PART and nothing else. IMPORTANT: translate only this part! Translation should not be longer than original text. If you add something from full text except this part, I will put you in jail!'
          },
          {
            role: 'user',
            content: 'Translate ONLY this text: ' + text
          }
        ],

        temperature: 0,
        max_tokens: 500,
        stop: ["\n", "<think>"]
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
        model: 'llama-3',

        messages: [
          {
            role: 'system',
            content: `I have a script that cut translated text and make pairs of original and translated text parts.
            This script sometimes fails and cut in wrong place so extra part of text is in translation.
            Your task is to double-check the translation and ensure it does not contain any extra text.
            Please return only the translation without extra text and without any explanations.
            Don't change or rephrase it, just remove extra text if it is there.`
          },
          {
            role: 'user',
            content: `Original text: "${text}".
            Translated to ${TRANSLATE_LANGUAGE} text: "${translation}".`
          }
        ],

        temperature: 0,
        max_tokens: 500,
        stop: ["\n", "<think>"]
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
  const translatedFullText = await initContext(fullText);

  for (const p of parts) {
    if (p.translated) continue;

    console.log(`O:  ${p.text}`);

    p.translated = await translateWithLLM(p.text, fullText, translatedFullText);
    
    console.log(`T:  ${p.translated}`);

    p.translated = await doubleCheckWithLLM(p.text, p.translated);

    console.log(`D:  ${p.translated}`);
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
    const cmd = `generate_audio --model-dir models/base-1.7b --text "${textEscaped}" --ref-audio "${p.file}" --language ${VOICEOVER_LANGUAGE} --output "${out}" --duration ${duration * 2} --repetition-penalty 2`;
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
    const translatedFile = '.' + path.join(TRANS_DIR, path.basename(p.file)).split(__dirname)[1];

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

    // const originalDuration = getDuration(p.file);
    const OFFSET = 0.2;
    const nextWord = allWords.find(w => w.start > p.end);
    const nextTime = nextWord ? nextWord.start - OFFSET : p.end + OFFSET;
    const originalDuration = nextTime - p.start; 
    const speed = translatedDuration / originalDuration;
    const startMs = Math.round(p.start * 1000);

    const atempoFilters = [];

console.log({
  file: p.translatedFile,
  translatedDuration: translatedDuration,
  slot: p.end - p.start,
  originalDuration,
  originalDurationFile: getDuration(p.file)
});

    const safeSpeed = Math.max(1, speed);

    atempoFilters.push(`atempo=${safeSpeed.toFixed(4)}`);

    const adelayFilter = `adelay=${startMs}|${startMs}`;

    const filterChain =
      `[${inputIdx}:a]${atempoFilters.join(',')},${adelayFilter}[part${inputIdx}]`;

    filterChains.push(filterChain);
    partLabels.push(`[part${inputIdx}]`);

    inputIdx++;
  }

  if (partLabels.length === 0) throw new Error('No valid parts to join');

  const mixFilter =
    `${partLabels.join('')}amix=inputs=${partLabels.length}:normalize=0:duration=longest[out]`;

  filterChains.push(mixFilter);

  const filterComplex = filterChains.join(';');

  args.push(
    '-filter_complex', filterComplex,
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

async function step9_makeVideo() {
  const outputVideo = path.join(__dirname, TRANSLATE_LANGUAGE + '_' + path.basename(INPUT_VIDEO));
  console.log('\n=== Step 9: Create video ===');
  run(`ffmpeg -i "${INPUT_VIDEO}" -i "${translatedVoiceFile}" -map 0:v -map 1:a -c:v copy -shortest "${outputVideo}" -y`);
  console.log(`Done! ${outputVideo}`);
}

async function main() {
  try {
    if (SKIP_TO_STEP <= 1) await step1_extractAudio();
    if (SKIP_TO_STEP <= 2) await step2_speechToText();
    if (SKIP_TO_STEP <= 3) await step3_parseTranscriptAndCut();
    if (SKIP_TO_STEP <= 5) await step5_translate();
    if (SKIP_TO_STEP <= 6) await step6_generateAudio();
    if (SKIP_TO_STEP <= 7) await step7_joinAudio();
    if (SKIP_TO_STEP <= 8) await step8_mixVoiceWithBackground();
    if (SKIP_TO_STEP <= 9) await step9_makeVideo();
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
