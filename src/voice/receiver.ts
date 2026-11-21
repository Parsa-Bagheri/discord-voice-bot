import { EventEmitter } from 'node:events';
import opus from '@discordjs/opus'; // CommonJS: named imports fail at runtime
const { OpusEncoder } = opus;
type OpusEncoder = InstanceType<typeof OpusEncoder>;
import { EndBehaviorType, type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import { stereo48kToMono16k } from '../audio/resample.js';

export interface ReceiverEvents {
  /** 20 ms of a user's speech as 16 kHz mono s16le. */
  audio: [userId: string, pcm16k: Buffer];
  /** Discord stopped receiving packets from this user (≈100 ms of silence). */
  speechEnd: [userId: string];
}

/** Subscribes to every (non-ignored) speaker in a voice connection and emits decoded PCM. */
export class VoiceReceiver extends EventEmitter<ReceiverEvents> {
  private readonly streams = new Map<string, { stream: AudioReceiveStream; decoder: OpusEncoder }>();
  private readonly onStart = (userId: string) => this.subscribe(userId);
  private readonly onEnd = (userId: string) => this.emit('speechEnd', userId);

  constructor(
    private readonly connection: VoiceConnection,
    private readonly shouldListen: (userId: string) => boolean,
  ) {
    super();
    connection.receiver.speaking.on('start', this.onStart);
    connection.receiver.speaking.on('end', this.onEnd);
  }

  private subscribe(userId: string): void {
    if (this.streams.has(userId) || !this.shouldListen(userId)) return;

    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new OpusEncoder(48000, 2);
    this.streams.set(userId, { stream, decoder });

    stream.on('data', (packet: Buffer) => {
      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet);
      } catch {
        return; // corrupt or undecryptable packet; skip it
      }
      if (pcm.length === 0 || pcm.length % 12 !== 0) return;
      this.emit('audio', userId, stereo48kToMono16k(pcm));
    });
    const cleanup = () => {
      if (this.streams.get(userId)?.stream === stream) this.streams.delete(userId);
    };
    stream.once('end', cleanup);
    stream.once('close', cleanup);
    stream.on('error', (err) => {
      console.warn(`[receiver] stream error for ${userId}:`, err.message);
      cleanup();
    });
  }

  /** Stop listening to a user (e.g. they left the channel). */
  unsubscribe(userId: string): void {
    this.streams.get(userId)?.stream.destroy();
    this.streams.delete(userId);
  }

  destroy(): void {
    this.connection.receiver.speaking.off('start', this.onStart);
    this.connection.receiver.speaking.off('end', this.onEnd);
    for (const { stream } of this.streams.values()) stream.destroy();
    this.streams.clear();
    this.removeAllListeners();
  }
}
