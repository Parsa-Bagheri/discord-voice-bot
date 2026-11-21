import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { Upsampler24kTo48kStereo } from '../audio/resample.js';

export interface PlayerEvents {
  /** All queued audio has finished playing. */
  idle: [];
}

// Gemini streams audio in bursts; tolerate up to 1 s of underrun before the player gives up.
const MAX_MISSED_FRAMES = 50;

/** Streams model audio (24 kHz mono) into a Discord voice connection, with instant interrupt. */
export class VoicePlayer extends EventEmitter<PlayerEvents> {
  private readonly player: AudioPlayer;
  private readonly upsampler = new Upsampler24kTo48kStereo();
  private stream: PassThrough | null = null;

  constructor(connection: VoiceConnection) {
    super();
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES },
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.stream = null;
      this.emit('idle');
    });
    this.player.on('error', (err) => console.warn('[player] error:', err.message));
    connection.subscribe(this.player);
  }

  get isPlaying(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  /** Queue 24 kHz mono s16le PCM for playback. */
  push(pcm24k: Buffer): void {
    if (!this.stream) {
      this.upsampler.reset();
      this.stream = new PassThrough();
      this.player.play(createAudioResource(this.stream, { inputType: StreamType.Raw }));
    }
    this.stream.write(this.upsampler.process(pcm24k));
  }

  /** No more audio for this reply; let the queue drain and then go idle. */
  end(): void {
    this.stream?.end();
    this.stream = null;
  }

  /** Stop immediately and drop anything queued. */
  interrupt(): void {
    this.stream?.destroy();
    this.stream = null;
    this.player.stop(true);
  }

  /** Short two-tone "listening" chime. */
  chime(): void {
    if (this.isPlaying) return;
    this.push(makeChime());
    this.end();
  }

  destroy(): void {
    this.interrupt();
    this.removeAllListeners();
  }
}

function makeChime(): Buffer {
  const rate = 24000;
  const tones: Array<[freq: number, seconds: number]> = [
    [880, 0.09],
    [1320, 0.12],
  ];
  const total = tones.reduce((n, [, s]) => n + Math.round(rate * s), 0);
  const buf = Buffer.alloc(total * 2);
  let offset = 0;
  for (const [freq, seconds] of tones) {
    const n = Math.round(rate * seconds);
    for (let i = 0; i < n; i++) {
      const envelope = Math.min(1, i / 240, (n - i) / 240); // 10 ms fade in/out
      const sample = Math.sin((2 * Math.PI * freq * i) / rate) * envelope * 0.25 * 32767;
      buf.writeInt16LE(Math.round(sample), offset);
      offset += 2;
    }
  }
  return buf;
}
