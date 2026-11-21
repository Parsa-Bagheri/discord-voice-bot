import type { SendableChannels } from 'discord.js';

/** Discord's hard limit is 2000 characters; leave a little headroom. */
const MAX_LENGTH = 1990;

/** Collapse runs of whitespace to single spaces and trim the result. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Split `text` into chunks of at most `limit` characters, preferring whitespace boundaries. */
function splitMessage(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    let cut = -1;
    for (let i = limit; i > 0; i--) {
      const char = rest[i];
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      // No whitespace boundary available: hard-split at the limit.
      cut = limit;
    }

    const chunk = rest.slice(0, cut).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }

  return chunks;
}

/**
 * Accumulates streaming transcript fragments for one conversational turn and
 * posts the formatted turn to a Discord text channel.
 */
export class TranscriptPoster {
  private channel: SendableChannels | null;
  private userDisplayName = '';
  private userText = '';
  private assistantText = '';
  private interrupted = false;

  constructor(channel: SendableChannels | null) {
    this.channel = channel;
  }

  setChannel(channel: SendableChannels | null): void {
    this.channel = channel;
  }

  /** Append a streamed fragment of what the user said (fragments arrive incrementally; concatenate as-is, they include their own spacing). */
  addUser(userDisplayName: string, fragment: string): void {
    this.userDisplayName = userDisplayName;
    this.userText += fragment;
  }

  /** Append a streamed fragment of what the assistant said. */
  addAssistant(fragment: string): void {
    this.assistantText += fragment;
  }

  /** Mark the assistant reply as interrupted (append " …(interrupted)" when flushed). */
  markInterrupted(): void {
    this.interrupted = true;
  }

  /** Post the accumulated turn (if non-empty) and clear. Never throws: catch and console.error send failures. */
  async flush(): Promise<void> {
    const channel = this.channel;

    const displayName = collapse(this.userDisplayName) || 'User';
    const userText = collapse(this.userText);
    const assistantText = collapse(this.assistantText);
    const interrupted = this.interrupted;

    // Clear immediately so a concurrent flush cannot re-post the same turn.
    this.userDisplayName = '';
    this.userText = '';
    this.assistantText = '';
    this.interrupted = false;

    const lines: string[] = [];
    if (userText.length > 0) {
      lines.push(`🎙️ **${displayName}:** ${userText}`);
    }
    if (assistantText.length > 0) {
      lines.push(`🤖 **Genius:** ${assistantText}${interrupted ? ' …(interrupted)' : ''}`);
    }

    if (lines.length === 0 || channel === null) {
      return;
    }

    const chunks = splitMessage(lines.join('\n'), MAX_LENGTH);
    for (const chunk of chunks) {
      try {
        await channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.error('[transcript] Failed to send transcript:', error);
      }
    }
  }
}
