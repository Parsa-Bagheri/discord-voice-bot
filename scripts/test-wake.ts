// Usage: npx tsx scripts/test-wake.ts <file.wav> [...more.wav]
// Feeds 16 kHz mono 16-bit WAV files through the wake word detector in 20 ms chunks,
// the same way the bot does, and prints any detections.
import fs from 'node:fs';
import { WakeWordDetector } from '../src/wake/detector.js';

function readWavPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let rate = 0;
  let channels = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      if (rate !== 16000 || channels !== 1) throw new Error(`${file}: need 16 kHz mono, got ${rate} Hz x${channels}`);
      return buf.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

const detector = new WakeWordDetector({
  modelDir: process.env.KWS_MODEL_DIR ?? 'models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
  keywordsFile: process.env.KWS_KEYWORDS_FILE ?? 'config/keywords.txt',
  threshold: Number(process.env.KWS_THRESHOLD ?? 0.25),
  score: Number(process.env.KWS_SCORE ?? 1.5),
});

for (const file of process.argv.slice(2)) {
  const pcm = readWavPcm(file);
  const hits: string[] = [];
  const chunkBytes = 640; // 20 ms at 16 kHz mono s16le
  for (let i = 0; i + chunkBytes <= pcm.length; i += chunkBytes) {
    const samples = new Float32Array(chunkBytes / 2);
    for (let j = 0; j < samples.length; j++) samples[j] = pcm.readInt16LE(i + j * 2) / 32768;
    const kw = detector.feed(file, samples);
    if (kw) hits.push(`${kw} @ ${((i + chunkBytes) / 32000).toFixed(2)}s`);
  }
  const tail = detector.flush(file);
  if (tail) hits.push(`${tail} @ end (flush)`);
  detector.remove(file);
  console.log(`${file}: ${hits.length ? hits.join(', ') : 'no detection'}`);
}
