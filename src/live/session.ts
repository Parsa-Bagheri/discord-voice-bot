import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality, type LiveConnectConfig, type LiveServerMessage, type Session } from '@google/genai';

export interface LiveSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  systemPrompt: string;
  googleSearch: boolean;
}

export interface LiveSessionEvents {
  /** 24 kHz mono s16le PCM from the model. */
  audio: [pcm: Buffer];
  /** User started talking over the model; stop playback immediately. */
  interrupted: [];
  /** Model finished its turn. */
  turnComplete: [];
  inputTranscript: [text: string];
  outputTranscript: [text: string];
  /** Server will drop the connection soon. */
  goAway: [timeLeft: string | undefined];
  close: [reason: string];
  error: [err: Error];
}

/** Thin wrapper around a single Gemini Live API WebSocket session. */
export class LiveSession extends EventEmitter<LiveSessionEvents> {
  private session: Session | null = null;
  private closed = false;

  constructor(private readonly opts: LiveSessionOptions) {
    super();
  }

  get isOpen(): boolean {
    return this.session !== null && !this.closed;
  }

  async connect(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.opts.apiKey, httpOptions: { apiVersion: 'v1beta' } });
    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: this.opts.systemPrompt,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(this.opts.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    };

    this.session = await ai.live.connect({
      model: this.opts.model,
      config,
      callbacks: {
        onmessage: (msg) => this.handleMessage(msg),
        onerror: (e) => this.emit('error', new Error(e.message ?? 'Live API error')),
        onclose: (e) => {
          this.closed = true;
          this.emit('close', e.reason || `code ${e.code}`);
        },
      },
    });
  }

  /** Send 16 kHz mono s16le PCM. */
  sendAudio(pcm16k: Buffer): void {
    if (!this.isOpen) return;
    this.session!.sendRealtimeInput({
      audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  /** Tell the server the mic paused so it finalizes the user's turn without waiting. */
  endAudioStream(): void {
    if (!this.isOpen) return;
    this.session!.sendRealtimeInput({ audioStreamEnd: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session?.close();
  }

  private handleMessage(msg: LiveServerMessage): void {
    const content = msg.serverContent;
    if (content) {
      // A single event can carry several parts (audio + transcripts), so check everything.
      if (content.interrupted) this.emit('interrupted');
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data && part.inlineData?.mimeType?.startsWith('audio/')) {
          this.emit('audio', Buffer.from(data, 'base64'));
        }
      }
      if (content.inputTranscription?.text) this.emit('inputTranscript', content.inputTranscription.text);
      if (content.outputTranscription?.text) this.emit('outputTranscript', content.outputTranscription.text);
      if (content.turnComplete) this.emit('turnComplete');
    }
    if (msg.goAway) this.emit('goAway', msg.goAway.timeLeft);
  }
}
