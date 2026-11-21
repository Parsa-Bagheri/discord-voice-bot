import { ChannelType, InteractionContextType, REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

/**
 * Slash command definitions shared by the registration script and (optionally)
 * interaction handlers. All commands are guild-only.
 */
export const commandData: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription("Join your current voice channel and listen for 'hey genius'")
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((option) =>
      option
        .setName('transcript')
        .setDescription('Text channel to post transcripts to (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel')
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription("Show the assistant's current state")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
];

/**
 * Register the slash commands with Discord.
 *
 * When `guildId` is provided the commands are registered to that guild
 * (instant updates, ideal for development); otherwise they are registered
 * globally (can take up to an hour to propagate).
 */
export async function registerCommands(opts: {
  token: string;
  clientId: string;
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(opts.token);

  const route = opts.guildId
    ? Routes.applicationGuildCommands(opts.clientId, opts.guildId)
    : Routes.applicationCommands(opts.clientId);

  await rest.put(route, { body: commandData });

  const scope = opts.guildId ? `guild ${opts.guildId}` : 'globally';
  const names = commandData.map((command) => `/${command.name}`).join(', ');
  console.log(`[commands] Registered ${commandData.length} commands ${scope}: ${names}`);
}
