// Usage: npx tsx scripts/test-live.ts <question.wav> [out.wav]
// Sends a 16 kHz mono 16-bit WAV to Gemini Live (using your .env) and saves the spoken
// reply to a WAV file, so you can verify the API key/model without Discord.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { LiveSession } from '../src/live/session.js';

const [input, output = 'reply.wav'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npx tsx scripts/test-live.ts <question.wav> [out.wav]');
  process.exit(1);
}

function readPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  const data = buf.indexOf('data', 12, 'ascii');
  if (data < 0) throw new Error('no data chunk');
  return buf.subarray(data + 8, data + 8 + buf.readUInt32LE(data + 4));
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const config = loadConfig();
const session = new LiveSession({
  apiKey: config.GEMINI_API_KEY,
  model: config.GEMINI_MODEL,
  voice: config.GEMINI_VOICE,
  systemPrompt: config.SYSTEM_PROMPT,
  googleSearch: config.ENABLE_GOOGLE_SEARCH,
});
const chunks: Buffer[] = [];
const started = Date.now();
let firstAudio = 0;

session.on('audio', (pcm) => {
  if (!firstAudio) firstAudio = Date.now();
  chunks.push(pcm);
});
session.on('inputTranscript', (t) => process.stdout.write(`[you] ${t}\n`));
session.on('outputTranscript', (t) => process.stdout.write(`[genius] ${t}\n`));
session.on('error', (e) => console.error('error:', e.message));
session.on('close', (r) => console.log('closed:', r));
session.on('turnComplete', () => {
  const pcm = Buffer.concat(chunks);
  fs.writeFileSync(output, wav(pcm, 24000));
  console.log(`\nfirst audio after ${firstAudio - sendDone} ms; ${(pcm.length / 48000).toFixed(1)} s of audio -> ${output}`);
  session.close();
});

await session.connect();
console.log(`connected in ${Date.now() - started} ms`);
const pcm = readPcm(input);
// Stream in real time-ish 20 ms chunks, then signal end of speech.
for (let i = 0; i < pcm.length; i += 640) {
  session.sendAudio(pcm.subarray(i, i + 640));
  await new Promise((r) => setTimeout(r, 5));
}
session.endAudioStream();
const sendDone = Date.now();
