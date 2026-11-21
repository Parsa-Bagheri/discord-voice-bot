#!/usr/bin/env node
/**
 * Downloads and extracts the sherpa-onnx KWS model used for the "hey genius"
 * wake word. Safe to run repeatedly: if the model is already present it is
 * skipped.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MODEL_DIR_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const modelsDir = path.join(projectRoot, 'models');
const modelDir = path.join(modelsDir, MODEL_DIR_NAME);
const tokensFile = path.join(modelDir, 'tokens.txt');
const archiveFile = path.join(modelsDir, `${MODEL_DIR_NAME}.tar.bz2`);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function download(url, destination) {
  console.log(`[models] Downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  if (total > 0) {
    console.log(`[models] Size: ${formatBytes(total)}`);
  }

  let received = 0;
  let nextMark = 0.1;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (total <= 0) return;
    const fraction = received / total;
    if (fraction >= nextMark) {
      console.log(`[models] ${Math.min(100, Math.round(fraction * 100))}% (${formatBytes(received)})`);
      nextMark = Math.floor(fraction * 10 + 1) / 10;
    }
  });

  await pipeline(body, createWriteStream(destination));
  console.log(`[models] Download complete (${formatBytes(received)})`);
}

async function main() {
  if (existsSync(tokensFile)) {
    console.log(`[models] ${MODEL_DIR_NAME} already present — skipping download.`);
    return;
  }

  await mkdir(modelsDir, { recursive: true });

  try {
    await download(MODEL_URL, archiveFile);

    console.log('[models] Extracting archive with tar...');
    execFileSync('tar', ['-xf', archiveFile, '-C', modelsDir], { stdio: 'inherit' });
    console.log('[models] Extraction complete.');

    if (!existsSync(tokensFile)) {
      throw new Error(`Expected ${tokensFile} after extraction but it is missing.`);
    }

    console.log(`[models] Model ready at ${modelDir}`);
  } finally {
    await rm(archiveFile, { force: true });
  }
}

main().catch((error) => {
  console.error('[models] Failed to prepare models:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
