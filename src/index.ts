import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, SendableChannels } from 'discord.js';
import { GuildAssistant } from './assistant.js';
import { registerCommands } from './commands.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { TranscriptPoster } from './transcript.js';
import { WakeWordDetector } from './wake/detector.js';

type GuildCommandInteraction = ChatInputCommandInteraction<'cached'>;

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    console.error(`[bot] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function destroyConnection(connection: VoiceConnection): void {
  if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy();
  }
}

const config = loadConfigOrExit();

const detector = new WakeWordDetector({
  modelDir: config.KWS_MODEL_DIR,
  keywordsFile: config.KWS_KEYWORDS_FILE,
  threshold: config.KWS_THRESHOLD,
  score: config.KWS_SCORE,
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const assistants = new Map<string, GuildAssistant>();

async function replyError(interaction: GuildCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('[bot] Failed to send error reply:', error);
  }
}

async function handleJoin(interaction: GuildCommandInteraction): Promise<void> {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: 'Join a voice channel first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const guild = interaction.guild;
  const guildId = guild.id;

  const existing = assistants.get(guildId);
  if (existing) {
    existing.destroy();
    assistants.delete(guildId);
    const oldConnection = getVoiceConnection(guildId);
    if (oldConnection) destroyConnection(oldConnection);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  let assistant: GuildAssistant | null = null;

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyConnection(connection);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (assistant === null || assistants.get(guildId) !== assistant) return;
    console.log(`[bot] Voice connection destroyed in guild ${guildId}`);
    assistant.destroy();
    assistants.delete(guildId);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    console.error(`[bot] Failed to join voice channel ${voiceChannel.id}:`, error);
    destroyConnection(connection);
    await interaction.editReply({ content: 'Failed to join the voice channel. Please try again.' });
    return;
  }

  const requested = interaction.options.getChannel('transcript');
  const target = requested ?? interaction.channel;
  const transcriptChannel: SendableChannels | null =
    target !== null && target.isSendable() ? target : null;

  assistant = new GuildAssistant({
    connection,
    config,
    detector,
    transcript: new TranscriptPoster(transcriptChannel),
    shouldListen: (userId) => userId !== client.user?.id && !client.users.cache.get(userId)?.bot,
    displayName: (userId) =>
      guild.members.cache.get(userId)?.displayName ??
      client.users.cache.get(userId)?.username ??
      'Someone',
  });
  assistants.set(guildId, assistant);

  console.log(`[bot] Joined ${voiceChannel.name} in guild ${guildId}`);

  const transcriptNote =
    transcriptChannel !== null ? ` Transcripts go to <#${transcriptChannel.id}>.` : '';
  await interaction.editReply({
    content: `Joined **${voiceChannel.name}** — say "hey genius" to ask me something.${transcriptNote}`,
  });
}

async function handleLeave(interaction: GuildCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const assistant = assistants.get(guildId);
  const connection = getVoiceConnection(guildId);

  if (!assistant && !connection) {
    await interaction.reply({
      content: "I'm not in a voice channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (assistant) {
    assistant.destroy();
    assistants.delete(guildId);
  }
  if (connection) destroyConnection(connection);

  console.log(`[bot] Left voice in guild ${guildId}`);
  await interaction.reply({ content: 'Left the voice channel.' });
}

async function handleStatus(interaction: GuildCommandInteraction): Promise<void> {
  const assistant = assistants.get(interaction.guildId);
  if (!assistant) {
    await interaction.reply({
      content: 'Not in a voice channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activeUserId = assistant.activeUserId;
  const content =
    activeUserId !== null
      ? `State: **${assistant.state}** (with <@${activeUserId}>)`
      : `State: **${assistant.state}**`;

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[bot] Logged in as ${readyClient.user.tag}`);

  try {
    await registerCommands({
      token: config.DISCORD_TOKEN,
      clientId: config.DISCORD_CLIENT_ID,
      guildId: config.DISCORD_DEV_GUILD_ID,
    });
  } catch (error) {
    console.error('[bot] Failed to register commands:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;

  try {
    switch (interaction.commandName) {
      case 'join':
        await handleJoin(interaction);
        break;
      case 'leave':
        await handleLeave(interaction);
        break;
      case 'status':
        await handleStatus(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`[bot] /${interaction.commandName} failed:`, error);
    await replyError(interaction, 'Something went wrong. Please try again.');
  }
});

client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
  const guild = newState.guild;
  const botId = client.user?.id;
  if (!botId) return;

  const channel = guild.voiceStates.cache.get(botId)?.channel;
  if (!channel) return;
  // Count voice states rather than channel.members: members may be uncached without the
  // GuildMembers intent, so treat anyone we can't identify as a human.
  const humansPresent = guild.voiceStates.cache.some(
    (state) => state.channelId === channel.id && state.id !== botId && !client.users.cache.get(state.id)?.bot,
  );
  if (humansPresent) return;

  const assistant = assistants.get(guild.id);
  const connection = getVoiceConnection(guild.id);
  if (!assistant && !connection) return;

  console.log(`[bot] No humans left in ${channel.name} (guild ${guild.id}); leaving`);
  if (assistant) {
    assistant.destroy();
    assistants.delete(guild.id);
  }
  if (connection) destroyConnection(connection);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[bot] Received ${signal}; shutting down`);

  for (const [guildId, assistant] of assistants) {
    assistant.destroy();
    const connection = getVoiceConnection(guildId);
    if (connection) destroyConnection(connection);
  }
  assistants.clear();

  client.destroy();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

try {
  await client.login(config.DISCORD_TOKEN);
} catch (error) {
  console.error('[bot] Failed to log in:', error);
  process.exit(1);
}
