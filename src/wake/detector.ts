import path from 'node:path';
import fs from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import type { KeywordSpotter, OnlineStream } from 'sherpa-onnx-node';

const SAMPLE_RATE = 16000;
// Discord stops sending packets when a user goes quiet, so the spotter never sees the
// trailing silence it needs to finalize a keyword. Pad with this much silence on flush().
const FLUSH_SILENCE = new Float32Array(Math.round(SAMPLE_RATE * 0.4));

export interface WakeWordOptions {
  modelDir: string;
  keywordsFile: string;
  threshold: number;
  score: number;
}

/** Runs one sherpa-onnx keyword spotter with an independent stream per Discord user. */
export class WakeWordDetector {
  private readonly kws: KeywordSpotter;
  private readonly streams = new Map<string, OnlineStream>();

  constructor(opts: WakeWordOptions) {
    const file = (name: string) => {
      const p = path.resolve(opts.modelDir, name);
      if (!fs.existsSync(p)) throw new Error(`Wake word model file missing: ${p} (run "npm run models")`);
      return p;
    };
    const keywordsFile = path.resolve(opts.keywordsFile);
    if (!fs.existsSync(keywordsFile)) throw new Error(`Keywords file missing: ${keywordsFile}`);

    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: file('encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          decoder: file('decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          joiner: file('joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
        },
        tokens: file('tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile,
      keywordsThreshold: opts.threshold,
      keywordsScore: opts.score,
    });
  }

  /** Feed 16 kHz mono float samples for a user. Returns the detected keyword, or null. */
  feed(userId: string, samples: Float32Array): string | null {
    const stream = this.streamFor(userId);
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    return this.decode(stream);
  }

  /** Call when a user stops speaking so a keyword at the very end of speech still fires. */
  flush(userId: string): string | null {
    const stream = this.streams.get(userId);
    if (!stream) return null;
    stream.acceptWaveform({ samples: FLUSH_SILENCE, sampleRate: SAMPLE_RATE });
    return this.decode(stream);
  }

  /** Drop a user's stream (e.g. they left the channel). */
  remove(userId: string): void {
    this.streams.delete(userId);
  }

  private streamFor(userId: string): OnlineStream {
    let stream = this.streams.get(userId);
    if (!stream) {
      stream = this.kws.createStream();
      this.streams.set(userId, stream);
    }
    return stream;
  }

  private decode(stream: OnlineStream): string | null {
    let detected: string | null = null;
    while (this.kws.isReady(stream)) {
      this.kws.decode(stream);
      const { keyword } = this.kws.getResult(stream);
      if (keyword) {
        detected = keyword;
        this.kws.reset(stream);
      }
    }
    return detected;
  }
}
