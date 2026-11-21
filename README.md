# Discord Voice Assistant ("Hey Genius")

A Discord voice-channel assistant that listens for the wake phrase **"hey genius"** entirely on your machine, then opens a [Gemini Live](https://ai.google.dev/gemini-api/docs/live) session for the person who said it. The wake word runs locally and free via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) open-vocabulary keyword spotting, so no audio is uploaded until you actually summon it. Once awake, the bot streams your voice to Gemini (`gemini-3.8-live`, native speech-to-speech), plays the spoken reply back into the call in real time, supports barge-in and follow-up questions, optionally grounds answers with Google Search, and posts text transcripts to a Discord text channel.

The Live session only exists for the duration of a conversation. That matters for cost: Gemini Live bills input audio for as long as the session is listening, so keeping the wake word local is what makes a typical question cost roughly **$0.005** on the paid tier.

## How it works

```
Discord voice (Opus, DAVE E2EE)
        │  decrypted by @discordjs/voice
        ▼
   Opus decode ──► 48 kHz stereo ──► 16 kHz mono
                                        │
                                        ▼
                     wake word "hey genius" (sherpa-onnx, local)
                                        │  match
                                        ▼
                                Gemini Live session
                                        │  24 kHz PCM
                                        ▼
                     48 kHz stereo ──► Opus ──► Discord voice channel
```

While idle, every speaker in the channel is fed to a local keyword spotter with its own stream. A match plays a short chime, opens the Live session, and switches to full-duplex relaying for that user. Silence for `END_OF_SPEECH_MS` tells Gemini the turn is over; the conversation stays open for `FOLLOWUP_WINDOW_MS` after the reply finishes so you can ask a follow-up without repeating the wake word.

## Requirements

- **Node.js >= 24.17** (see `engines` in `package.json`)
- A Discord application with a bot user
- A Gemini API key from <https://aistudio.google.com/apikey>

Native dependencies (`@discordjs/opus`, `sherpa-onnx-node`) ship prebuilt binaries, so no compiler toolchain is needed. npm 11+ blocks install scripts by default; the ones this project needs are already approved in `package.json` (`allowScripts`), so a plain `npm install` works.

No ffmpeg is required — audio is decoded and resampled in-process.

## Setup

### 1. Install dependencies and the wake word model

```bash
git clone https://github.com/Parsa-Bagheri/discord-voice-bot.git
cd discord-voice-bot
npm install
npm run models
```

`npm run models` downloads and extracts the sherpa-onnx KWS model (~19 MB) into `models/`. It is safe to re-run; an existing model is skipped.

### 2. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Go to **Bot** and click **Reset Token**, then copy the token into `DISCORD_TOKEN`.
3. Copy the **Application ID** from the General Information page into `DISCORD_CLIENT_ID`.
4. Invite the bot with scopes `bot applications.commands` and permissions **View Channels**, **Send Messages**, **Connect**, **Speak**:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=3148800
   ```

No privileged intents (Message Content, Server Members, Presence) are required.

### 3. Configure

```bash
cp .env.example .env        # Windows: Copy-Item .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `GEMINI_API_KEY`. During development, set `DISCORD_DEV_GUILD_ID` to your server's ID so slash commands register instantly instead of waiting for global propagation.

## Running

```bash
npm start        # run once
npm run dev      # watch mode (restarts on file changes)
```

Then, in a Discord server:

1. Join a voice channel and run **`/join`**. Optionally pass `transcript:#channel` to choose where transcripts are posted (defaults to the channel where you ran the command).
2. Say **"hey genius"** — you will hear a short two-tone chime when it wakes.
3. Ask your question. You can talk over the bot at any time to interrupt it.
4. Ask follow-ups for a few seconds after it finishes (no wake word needed), or say the wake word again later.
5. Run **`/status`** to see whether it is listening or in a conversation, and **`/leave`** to disconnect.

## Configuration

All variables live in `.env` (see `.env.example`). Values are validated at startup with zod; an invalid or missing required value aborts with a clear error.

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | — (required) | Bot token from the Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | — (required) | Application ID, used to register slash commands. |
| `DISCORD_DEV_GUILD_ID` | *(empty)* | Register commands to this guild for instant updates during development. Empty = global registration (can take up to an hour). |
| `GEMINI_API_KEY` | — (required) | Gemini API key from Google AI Studio. |
| `GEMINI_MODEL` | `gemini-3.8-live` | Live API model name. |
| `GEMINI_VOICE` | `Puck` | Prebuilt voice used for spoken replies. |
| `ENABLE_GOOGLE_SEARCH` | `true` | Enable Google Search grounding as a Live API tool. |
| `SYSTEM_PROMPT` | *(see `.env.example`)* | System instruction for the assistant. Defaults to a short, conversational "Genius" persona. |
| `KWS_MODEL_DIR` | `models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` | Directory containing the sherpa-onnx KWS model files. |
| `KWS_KEYWORDS_FILE` | `config/keywords.txt` | Keywords file defining the wake phrases. |
| `KWS_THRESHOLD` | `0.25` | Global detection threshold (0–1). Lower = more sensitive. |
| `KWS_SCORE` | `1.5` | Global keyword boosting score. Higher = stronger boost. |
| `FOLLOWUP_WINDOW_MS` | `8000` | How long the session stays open after a reply so you can ask a follow-up. |
| `END_OF_SPEECH_MS` | `700` | Silence duration that marks the end of your turn. |

## Tuning the wake word

`config/keywords.txt` uses the sherpa-onnx keyword format: **BPE tokens, then `@label`**. The label is what the bot logs and matches; multiple token sequences can share one label, which is handy for pronunciation variants:

```text
▁HE Y ▁G EN I US @HEY_GENIUS
▁HI ▁G EN I US @HEY_GENIUS
```

Each line may also carry per-keyword overrides between the tokens and the label: `:boost` (same meaning as `KWS_SCORE`) and `#threshold` (same meaning as `KWS_THRESHOLD`), for example:

```text
▁HE Y ▁G EN I US :2.0 #0.2 @HEY_GENIUS
```

### Adding a new phrase

Generate the BPE tokens with the model's `bpe.model` using Python `sentencepiece`:

```bash
python -c "import sentencepiece as s; m=s.SentencePieceProcessor(model_file='models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/bpe.model'); print(' '.join(m.encode('HEY GENIUS', out_type=str)))"
```

Append `@YOUR_LABEL` to the output and add the line to `config/keywords.txt`. The `▁` prefix marks a word boundary — keep the tokens exactly as printed.

### Tuning knobs

- **`KWS_THRESHOLD`** (default `0.25`): lower values make detection more sensitive and reduce misses, at the cost of more false triggers. Raise it if the bot wakes on ordinary conversation.
- **`KWS_SCORE`** (default `1.5`): boosts the keyword's decoder score. Higher values make the exact phrase more likely to win, but can also increase false positives.
- Per-line `:boost` / `#threshold` overrides let you tune one phrase without affecting the others.

### Testing a phrase

Feed a **16 kHz mono 16-bit WAV** through the detector exactly as the bot would:

```bash
npx tsx scripts/test-wake.ts path/to/recording.wav
```

It prints each detection and its timestamp, or `no detection`. Convert other audio to 16 kHz mono first (for example with ffmpeg on your own machine — the bot itself does not need it).

## Costs

- Wake word detection is **local and free**; nothing is uploaded while idle.
- A Live session is opened only after a wake word and closed when the conversation goes quiet, because Gemini 3.8 Live bills **input audio for the entire time the session is listening**. This is what keeps the bill low — roughly **$0.005 per typical question** on the paid tier.
- A free tier is available, but Google may use free-tier data to improve its products. Use the paid tier if that matters to you.
- Google Search grounding and audio output are billed according to the current Gemini API pricing; see the [pricing page](https://ai.google.dev/gemini-api/docs/pricing).

## Tests

```bash
npm test                                   # resampler unit tests
npm run typecheck                          # TypeScript, no emit
npm run test:wake -- question.wav          # run a 16 kHz mono WAV through the wake word detector
npm run test:live -- question.wav out.wav  # send a WAV to Gemini Live (uses .env) and save the spoken reply
```

`test:live` is the quickest way to confirm your Gemini key and model work before involving Discord. It prints the transcripts, the time to first audio, and writes the reply as a 24 kHz WAV.

## Troubleshooting

- **The bot joins but never hears anyone.** The bot joins with `selfDeaf: false` — if it is self-deafened, Discord sends it no audio. Make sure it has the **Connect** permission in that channel, and that you are not muted. If you see DAVE/E2EE decryption errors in the logs, update `@discordjs/voice` (`npm install @discordjs/voice@latest`); DAVE support is still evolving.
- **Wake word misses or triggers too often.** Lower `KWS_THRESHOLD` (e.g. `0.15`) if it misses, raise it (e.g. `0.35`) if it fires on normal speech. `KWS_SCORE` and per-line `:boost` values can help too. Verify your recording with `scripts/test-wake.ts` before blaming the mic.
- **`Wake word model file missing: ... (run "npm run models")`.** The model was not downloaded or was deleted. Run `npm run models` from the project root, or point `KWS_MODEL_DIR` at an existing model directory.
- **Live API errors.** Check that `GEMINI_API_KEY` is valid, that `GEMINI_MODEL` is a Live-capable model (`gemini-3.8-live`), and that your key's project has the Live API enabled. Free-tier keys are rate-limited; back off and retry, or use a paid key.
- **No transcript appears.** Transcripts go to the channel used with `/join` (or the `transcript` option). The bot needs **View Channels** and **Send Messages** there.

## Project structure

```text
src/
  index.ts               Bot bootstrap: Discord client, command registration, /join /leave /status handlers
  config.ts              Loads and validates environment variables with zod
  commands.ts            Slash command definitions and REST registration
  assistant.ts           Per-guild state machine: listening → connecting → conversing
  transcript.ts          Accumulates a turn's transcripts and posts them to a text channel
  audio/
    resample.ts          48 kHz stereo ↔ 16 kHz mono, 24 kHz → 48 kHz stereo, s16le → float32
    resample.test.ts     node:test unit tests for the resamplers
  live/
    session.ts           Thin wrapper around a single Gemini Live WebSocket session
  voice/
    receiver.ts          Subscribes to speakers and decodes Opus packets to PCM
    player.ts            Streams model audio to Discord, plays the chime, handles interrupts
  wake/
    detector.ts          sherpa-onnx keyword spotter with an independent stream per user
  types/
    sherpa-onnx-node.d.ts  TypeScript declarations for the sherpa-onnx-node bindings

scripts/
  download-models.mjs    Downloads and extracts the KWS model into models/
  test-wake.ts           Feeds 16 kHz mono WAV files through the wake word detector
  test-live.ts           Sends a WAV question to Gemini Live and saves the spoken reply

config/
  keywords.txt           Wake phrases as BPE tokens + @label
```

## License

MIT.

The bundled wake word model (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`) is **Apache-2.0**, from the [k2-fsa / sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project. It is downloaded by `npm run models`, not committed to the repository.
