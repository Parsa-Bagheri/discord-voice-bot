import type { VoiceConnection } from '@discordjs/voice';
import type { Config } from './config.js';
import { s16leToFloat32 } from './audio/resample.js';
import { LiveSession } from './live/session.js';
import type { TranscriptPoster } from './transcript.js';
import { VoicePlayer } from './voice/player.js';
import { VoiceReceiver } from './voice/receiver.js';
import type { WakeWordDetector } from './wake/detector.js';

export type AssistantState = 'listening' | 'connecting' | 'conversing';

export interface AssistantDeps {
  connection: VoiceConnection;
  config: Config;
  detector: WakeWordDetector;
  transcript: TranscriptPoster;
  /** Whether to process audio from this user (e.g. false for bots). */
  shouldListen: (userId: string) => boolean;
  displayName: (userId: string) => string;
}

// If the user stops talking and the model never answers (proactive audio can choose to
// stay silent), give up after this long rather than holding the session open.
const RESPONSE_TIMEOUT_MS = 15_000;
// Cap how much audio we buffer while the Live session is still connecting.
const MAX_PENDING_CHUNKS = 500; // 10 s of 20 ms frames

/**
 * Per-guild state machine: listen for the wake word on every speaker, then open a
 * Gemini Live session for whoever said it and relay audio both ways until the
 * conversation goes quiet.
 */
export class GuildAssistant {
  private readonly receiver: VoiceReceiver;
  private readonly player: VoicePlayer;
  private _state: AssistantState = 'listening';
  private activeUser: string | null = null;
  private session: LiveSession | null = null;
  private pending: Buffer[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private endOfSpeechTimer: NodeJS.Timeout | null = null;
  private awaitingFollowUp = false;

  constructor(private readonly deps: AssistantDeps) {
    this.receiver = new VoiceReceiver(deps.connection, deps.shouldListen);
    this.player = new VoicePlayer(deps.connection);
    this.receiver.on('audio', (userId, pcm) => this.onUserAudio(userId, pcm));
    this.receiver.on('speechEnd', (userId) => this.onUserSpeechEnd(userId));
    this.player.on('idle', () => {
      if (this.awaitingFollowUp) this.armIdleTimer(this.deps.config.FOLLOWUP_WINDOW_MS);
    });
  }

  get state(): AssistantState {
    return this._state;
  }

  get activeUserId(): string | null {
    return this.activeUser;
  }

  destroy(): void {
    this.endSession('assistant destroyed');
    this.receiver.destroy();
    this.player.destroy();
  }

  private onUserAudio(userId: string, pcm: Buffer): void {
    switch (this._state) {
      case 'listening': {
        const keyword = this.deps.detector.feed(userId, s16leToFloat32(pcm));
        if (keyword) void this.wake(userId, keyword);
        break;
      }
      case 'connecting':
        if (userId === this.activeUser && this.pending.length < MAX_PENDING_CHUNKS) this.pending.push(pcm);
        break;
      case 'conversing':
        if (userId !== this.activeUser) break;
        this.clearTimer('endOfSpeechTimer');
        this.clearTimer('idleTimer');
        this.awaitingFollowUp = false;
        this.session?.sendAudio(pcm);
        break;
    }
  }

  private onUserSpeechEnd(userId: string): void {
    if (this._state === 'listening') {
      const keyword = this.deps.detector.flush(userId);
      if (keyword) void this.wake(userId, keyword);
      return;
    }
    if (this._state !== 'conversing' || userId !== this.activeUser) return;

    this.clearTimer('endOfSpeechTimer');
    this.endOfSpeechTimer = setTimeout(() => {
      this.endOfSpeechTimer = null;
      this.session?.endAudioStream();
    }, this.deps.config.END_OF_SPEECH_MS);
    this.armIdleTimer(RESPONSE_TIMEOUT_MS);
  }

  private async wake(userId: string, keyword: string): Promise<void> {
    if (this._state !== 'listening') return;
    console.log(`[assistant] wake word "${keyword}" from ${this.deps.displayName(userId)}`);

    this._state = 'connecting';
    this.activeUser = userId;
    this.pending = [];
    this.player.chime();

    const { config } = this.deps;
    const session = new LiveSession({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      voice: config.GEMINI_VOICE,
      systemPrompt: config.SYSTEM_PROMPT,
      googleSearch: config.ENABLE_GOOGLE_SEARCH,
    });
    this.session = session;
    this.attachSession(session, userId);

    try {
      await session.connect();
    } catch (err) {
      console.error('[assistant] failed to open Live session:', err);
      this.endSession('connect failed');
      return;
    }
    // The session may have been torn down (e.g. /leave) while we were connecting.
    if (this.session !== session) return;

    this._state = 'conversing';
    for (const chunk of this.pending) session.sendAudio(chunk);
    this.pending = [];
    // Nothing said after the wake word yet: wait one follow-up window for a question.
    this.awaitingFollowUp = true;
    this.armIdleTimer(config.FOLLOWUP_WINDOW_MS);
  }

  private attachSession(session: LiveSession, userId: string): void {
    const { transcript } = this.deps;
    const isCurrent = () => this.session === session;

    session.on('audio', (pcm) => {
      if (!isCurrent()) return;
      this.clearTimer('idleTimer');
      this.awaitingFollowUp = false;
      this.player.push(pcm);
    });
    session.on('interrupted', () => {
      if (!isCurrent()) return;
      this.player.interrupt();
      transcript.markInterrupted();
    });
    session.on('inputTranscript', (text) => {
      if (isCurrent()) transcript.addUser(this.deps.displayName(userId), text);
    });
    session.on('outputTranscript', (text) => {
      if (isCurrent()) transcript.addAssistant(text);
    });
    session.on('turnComplete', () => {
      if (!isCurrent()) return;
      this.player.end();
      void transcript.flush();
      this.awaitingFollowUp = true;
      // If playback already drained, start the follow-up window now; otherwise the
      // player's idle event will start it once the reply finishes playing.
      if (!this.player.isPlaying) this.armIdleTimer(this.deps.config.FOLLOWUP_WINDOW_MS);
    });
    session.on('goAway', (timeLeft) => console.warn(`[assistant] Live API goAway (time left: ${timeLeft ?? '?'})`));
    session.on('error', (err) => console.error('[assistant] Live session error:', err.message));
    session.on('close', (reason) => {
      if (!isCurrent()) return;
      console.log(`[assistant] Live session closed: ${reason}`);
      this.endSession('server closed');
    });
  }

  private armIdleTimer(ms: number): void {
    this.clearTimer('idleTimer');
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.endSession('idle');
    }, ms);
  }

  private clearTimer(name: 'idleTimer' | 'endOfSpeechTimer'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private endSession(reason: string): void {
    this.clearTimer('idleTimer');
    this.clearTimer('endOfSpeechTimer');
    const session = this.session;
    this.session = null;
    if (session) {
      session.close();
      this.player.end();
      void this.deps.transcript.flush();
      console.log(`[assistant] conversation ended (${reason})`);
    }
    // Start the active user's wake word stream fresh so stale audio can't re-trigger.
    if (this.activeUser) this.deps.detector.remove(this.activeUser);
    this.activeUser = null;
    this.pending = [];
    this.awaitingFollowUp = false;
    this._state = 'listening';
  }
}
