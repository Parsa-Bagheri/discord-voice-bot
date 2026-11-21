import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().optional().transform((v) => v || undefined),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.8-live'),
  GEMINI_VOICE: z.string().default('Puck'),
  ENABLE_GOOGLE_SEARCH: bool.default(true),
  SYSTEM_PROMPT: z
    .string()
    .default(
      'You are Genius, a helpful, witty voice assistant in a Discord voice call. Keep answers short and conversational (1-3 sentences) unless asked for detail. The user may begin with the wake phrase "hey genius"; ignore it.',
    ),

  KWS_MODEL_DIR: z.string().default('models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'),
  KWS_KEYWORDS_FILE: z.string().default('config/keywords.txt'),
  KWS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
  KWS_SCORE: z.coerce.number().positive().default(1.5),

  FOLLOWUP_WINDOW_MS: z.coerce.number().int().nonnegative().default(8000),
  END_OF_SPEECH_MS: z.coerce.number().int().positive().default(700),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (check your .env):\n${issues}`);
  }
  return parsed.data;
}
