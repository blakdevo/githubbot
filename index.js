require('dotenv').config();
const { Client, GatewayIntentBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const SteamAPI = require('steamapi');
const steam = new SteamAPI(process.env.STEAM_API_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: ['MESSAGE', 'CHANNEL']
});

const VERIFIED_ROLE_ID = process.env.ROLE_ID;
const GUILD_ID = process.env.GUILD_ID;
const FARMERS_ROLE = 'FARMERS';
const BOSS_ADMIN_ROLES = ['BOSS', 'ADMIN'];
const RESERVATION_CHANNEL_ID = '1439697453455638649';
const SIGNUP_CHANNEL_ID = '1439720240799027345';

const PENDING_USERS = new Map();
const RENT_SYSTEMS = new Map();
const EVENTS = new Map();

client.once('ready', async () => {
  console.log(`Bot is running: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('rentsystem').setDescription('Create lobby rental system in this channel'),
    new SlashCommandBuilder().setName('clear').setDescription('Clear all messages in this channel'),
    new SlashCommandBuilder().setName('book').setDescription('Make a reservation'),
    new SlashCommandBuilder().setName('setupreservation').setDescription('Setup permanent "Make Reservation" button (Admin only)'),
    new SlashCommandBuilder().setName('setupsignup').setDescription('Setup verification instructions in sign-up channel (Admin only)'),
    new SlashCommandBuilder()
      .setName('event')
      .setDescription('Create a new lobby event')
      .addStringOption(o => o.setName('name').setDescription('Event name').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Event description').setRequired(true))
      .addStringOption(o => o.setName('when').setDescription('When? (in 3 hours, 22:30, tomorrow 21:00)').setRequired(true))
      .addIntegerOption(o => o.setName('slots').setDescription('Max players (1-3)').setRequired(true).setMinValue(1).setMaxValue(3))
  ];

  await client.application.commands.set(commands, GUILD_ID);
  console.log('Commands registered!');
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'rentsystem') {
      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only **BOSS/ADMIN**!', ephemeral: true });
      if (RENT_SYSTEMS.has(interaction.channel.id)) return interaction.reply({ content: 'Rent system already exists!', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await createRentSystem(interaction.channel, [null, null, null]);
      await interaction.editReply({ content: 'Rent system created!' });
    }

    if (interaction.commandName === 'clear') {
      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only **BOSS/ADMIN**!', ephemeral: true });
      const system = RENT_SYSTEMS.get(interaction.channel.id);
      if (system?.timer) clearInterval(system.timer);
      await interaction.deferReply({ ephemeral: true });
      await interaction.channel.bulkDelete(100).catch(() => {});
      RENT_SYSTEMS.delete(interaction.channel.id);
      await interaction.editReply({ content: 'Channel cleared!' });
    }

    if (interaction.commandName === 'book') {
      if (interaction.channel.id !== RESERVATION_CHANNEL_ID) return interaction.reply({ content: 'Only in reservation channel!', ephemeral: true });
      showReservationModal(interaction);
    }

    if (interaction.commandName === 'setupreservation') {
      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only **BOSS/ADMIN**!', ephemeral: true });
      if (interaction.channel.id !== RESERVATION_CHANNEL_ID) return interaction.reply({ content: 'Only in reservation channel!', ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle('LOBBY RESERVATION')
        .setDescription('Click the button below to reserve a lobby.\nYou will be asked for date and time.\nWe will contact you as soon as possible.')
        .setColor('#00ff00')
        .setFooter({ text: 'Only FARMERS can reserve.' });

      const button = new ButtonBuilder()
        .setCustomId('book_button')
        .setLabel('Make Reservation')
        .setStyle(ButtonStyle.Success);

      await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    }

    if (interaction.commandName === 'setupsignup') {
      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only **BOSS/ADMIN**!', ephemeral: true });
      if (interaction.channel.id !== SIGNUP_CHANNEL_ID) return interaction.reply({ content: 'Only in sign-up channel!', ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle('VERIFICATION')
        .setDescription(`**Welcome to the server!**\n\nPlease send your **Steam profile link** in **this channel**:\n\n\`https://steamcommunity.com/profiles/99999999...\`\n\n**Example:**\nhttps://steamcommunity.com/profiles/99999999987654321\n\nAfter successful verification:\n• Your nickname will be your Steam name\n• You will receive the **FARMERS** role\n• All channels will be unlocked\n\n**You will be kicked if you don't send a link within 5 minutes.**`)
        .setColor('#00ff00');

      await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'event') {
      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only **BOSS/ADMIN**!', ephemeral: true });

      const name = interaction.options.getString('name');
      const description = interaction.options.getString('description');
      const when = interaction.options.getString('when').trim();
      const slots = interaction.options.getInteger('slots');

      await interaction.deferReply();

      const startTime = parseTimeInput(when);
      if (!startTime || startTime < Date.now() + 60000) {
        return interaction.editReply({ content: 'Invalid or past time! Example: `in 3 hours`, `22:30`, `tomorrow 21:00`' });
      }

      const eventId = Date.now().toString();
      const participants = [];

      const embed = createEventEmbed(name, description, startTime, slots, participants);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`join_event_${eventId}`)
          .setLabel('Join Lobby')
          .setStyle(ButtonStyle.Success)
      );

      const msg = await interaction.editReply({
        content: `**EVENT CREATED!** Starts <t:${Math.floor(startTime / 1000)}:R>`,
        embeds: [embed],
        components: [row]
      });

      EVENTS.set(eventId, {
        name, description, startTime, maxSlots: slots, participants,
        messageId: msg.id, channelId: interaction.channel.id
      });

      setTimeout(() => autoStartRentSystem(eventId), startTime - Date.now());
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'book_button') {
      showReservationModal(interaction);
    }

    if (interaction.customId.startsWith('join_event_')) {
      const eventId = interaction.customId.split('_')[2];
      const event = EVENTS.get(eventId);
      if (!event || Date.now() > event.startTime) return interaction.reply({ content: 'Event closed or already started.', ephemeral: true });

      if (event.participants.includes(interaction.user.id)) return interaction.reply({ content: 'You already joined!', ephemeral: true });
      if (event.participants.length >= event.maxSlots) return interaction.reply({ content: 'Lobby is full!', ephemeral: true });
      if (!interaction.member.roles.cache.some(r => r.name === FARMERS_ROLE)) return interaction.reply({ content: 'Only FARMERS!', ephemeral: true });

      event.participants.push(interaction.user.id);
      EVENTS.set(eventId, event);

      const embed = createEventEmbed(event.name, event.description, event.startTime, event.maxSlots, event.participants);
      const disabled = event.participants.length >= event.maxSlots;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`join_event_${eventId}`)
          .setLabel(disabled ? 'Full' : 'Join Lobby')
          .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
          .setDisabled(disabled)
      );

      await interaction.update({ embeds: [embed], components: [row] });
      await interaction.followUp({ content: `✅ <@${interaction.user.id}> joined! (${event.participants.length}/${event.maxSlots})` });
    }

    if (interaction.customId.startsWith('rent_slot_')) {
      const parts = interaction.customId.split('_');
      const channelId = parts[2];
      const slotIndex = parseInt(parts[3]);
      const system = RENT_SYSTEMS.get(channelId);
      if (!system || system.slots[slotIndex]) return interaction.reply({ content: 'Slot taken!', ephemeral: true });
      if (!interaction.member.roles.cache.some(r => r.name === FARMERS_ROLE)) return interaction.reply({ content: 'Only FARMERS!', ephemeral: true });

      const approve = new ButtonBuilder().setCustomId(`approve_${channelId}_${slotIndex}`).setLabel('Approve').setStyle(ButtonStyle.Success);
      const deny = new ButtonBuilder().setCustomId(`deny_${channelId}_${slotIndex}`).setLabel('Deny').setStyle(ButtonStyle.Danger);

      const embed = new EmbedBuilder()
        .setTitle(`SLOT ${slotIndex + 1} REQUEST`)
        .setDescription(`<@${interaction.user.id}> wants to rent this slot.`)
        .setColor('#ffff00');

      await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(approve, deny)] });
    }

    if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_')) {
      const parts = interaction.customId.split('_');
      const action = parts[0];
      const channelId = parts[1];
      const slotIndex = parseInt(parts[2]);
      const system = RENT_SYSTEMS.get(channelId);
      if (!system) return;

      if (!interaction.member.roles.cache.some(r => BOSS_ADMIN_ROLES.includes(r.name))) return interaction.reply({ content: 'Only BOSS/ADMIN!', ephemeral: true });

      const requesterId = interaction.message.embeds[0].description.match(/<@(\d+)>/)[1];

      if (action === 'approve') {
        system.slots[slotIndex] = { userId: requesterId, endTime: Date.now() + (4 * 3600000 + 10 * 60000) };
        await interaction.update({ content: `APPROVED — <@${requesterId}> rented the slot`, embeds: [], components: [] });
        updateLobbyEmbed(interaction.channel);
      } else {
        await interaction.update({ content: 'DENIED', embeds: [], components: [] });
      }
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'reservation_modal') {
    const date = interaction.fields.getTextInputValue('date_input');
    const time = interaction.fields.getTextInputValue('time_input');
    const steamNick = interaction.member.nickname || interaction.user.username;

    const dmContent = `**New Reservation!**\nUser: ${interaction.user.tag} (${interaction.user.id})\nSteam: **${steamNick}**\nDate: ${date}\nTime: ${time}`;

    const ids = ['290021992881586176', '338337150573477905', '482454845081649152'];
    for (const id of ids) {
      try { await client.users.fetch(id).then(u => u.send(dmContent)); } catch {}
    }

    await interaction.reply({ content: 'Reservation request sent!', ephemeral: true });
  }
});

function showReservationModal(interaction) {
  const modal = new ModalBuilder().setCustomId('reservation_modal').setTitle('Lobby Reservation');
  const date = new TextInputBuilder().setCustomId('date_input').setLabel('Date (DD/MM/YYYY)').setStyle(TextInputStyle.Short).setPlaceholder('17/11/2025').setRequired(true);
  const time = new TextInputBuilder().setCustomId('time_input').setLabel('Time (HH:MM)').setStyle(TextInputStyle.Short).setPlaceholder('22:00').setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(date), new ActionRowBuilder().addComponents(time));
  interaction.showModal(modal);
}

function parseTimeInput(input) {
  input = input.toLowerCase().trim();
  const now = Date.now();

  if (input.startsWith('in ')) {
    const num = parseFloat(input.replace('in ', '').replace(/hours?|hrs?|h/gi, ''));
    if (!isNaN(num)) return now + num * 3600000;
  }

  const timeMatch = input.match(/(\d{1,2}):?(\d{2})?/);
  if (timeMatch) {
    let date = new Date();
    date.setHours(parseInt(timeMatch[1]), timeMatch[2] ? parseInt(timeMatch[2]) : 0, 0, 0);
    if (date.getTime() < now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  if (input.includes('tomorrow')) {
    let date = new Date();
    date.setDate(date.getDate() + 1);
    const time = input.replace(/tomorrow/gi, '').trim();
    const m = time.match(/(\d{1,2}):?(\d{2})?/);
    if (m) date.setHours(parseInt(m[1]), m[2] ? parseInt(m[2]) : 0, 0, 0);
    else date.setHours(21, 0, 0, 0);
    return date.getTime();
  }

  return null;
}

function createEventEmbed(name, desc, startTime, maxSlots, participants) {
  const timeStr = `<t:${Math.floor(startTime / 1000)}:F> (<t:${Math.floor(startTime / 1000)}:R>)`;
  return new EmbedBuilder()
    .setTitle(`LOBBY EVENT: ${name}`)
    .setDescription(desc)
    .addFields(
      { name: 'Starts', value: timeStr, inline: true },
      { name: 'Slots', value: `${participants.length}/${maxSlots}`, inline: true },
      { name: 'Participants', value: participants.length ? participants.map(id => `<@${id}>`).join('\n') : 'Nobody yet' }
    )
    .setColor(participants.length >= maxSlots ? '#00ff00' : '#0099ff')
    .setFooter({ text: 'Everyone sees the time in their own timezone!' });
}

async function autoStartRentSystem(eventId) {
  const event = EVENTS.get(eventId);
  if (!event) return;

  const channel = client.channels.cache.get(event.channelId);
  if (!channel) return;

  if (event.participants.length === 0) {
    await channel.send(`Event "${event.name}" canceled — no participants.`);
    return EVENTS.delete(eventId);
  }

  await channel.send(`**EVENT STARTED!** "${event.name}"\nParticipants: ${event.participants.map(id => `<@${id}>`).join(', ')}\nRent system activated...`);
  await createRentSystem(channel, [null, null, null]);
  EVENTS.delete(eventId);
}

async function createRentSystem(channel, slots) {
  const embed = new EmbedBuilder()
    .setTitle('LOBBY')
    .setDescription('**If you have made your payment, make your selection.**\nYour time will start when your payment is approved.')
    .setColor('#0099ff');

  let desc = '';
  const names = ['CT1 Paid', 'CT2 Paid', 'T Paid'];
  for (let i = 0; i < 3; i++) {
    if (slots[i] && slots[i].endTime > Date.now()) {
      desc += `${names[i]}: <@${slots[i].userId}> — **${formatTime(slots[i].endTime - Date.now())}**\n`;
    } else {
      desc += `${names[i]}: Available\n`;
      slots[i] = null;
    }
  }
  embed.addFields({ name: '\u200B', value: desc || 'All slots empty' });

  const components = [];
  const labels = ['CT1 Paid', 'CT2 Paid', 'T Paid'];
  for (let i = 0; i < 3; i++) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rent_slot_${channel.id}_${i}`)
        .setLabel(labels[i])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!!slots[i])
    ));
  }

  const msg = await channel.send({ embeds: [embed], components });
  RENT_SYSTEMS.set(channel.id, { message: msg, slots, timer: null });
  startTimerForChannel(channel);
}

async function updateLobbyEmbed(channel) {
  const system = RENT_SYSTEMS.get(channel.id);
  if (!system || !system.message) return;

  const embed = new EmbedBuilder()
    .setTitle('LOBBY')
    .setDescription('**If you have made your payment, make your selection.**\nYour time will start when your payment is approved.')
    .setColor('#0099ff');

  let desc = '';
  const names = ['CT1 Paid', 'CT2 Paid', 'T Paid'];
  for (let i = 0; i < 3; i++) {
    const slot = system.slots[i];
    if (slot && slot.endTime > Date.now()) {
      desc += `${names[i]}: <@${slot.userId}> — **${formatTime(slot.endTime - Date.now())}**\n`;
    } else {
      desc += `${names[i]}: Available\n`;
      system.slots[i] = null;
    }
  }
  embed.addFields({ name: '\u200B', value: desc || 'All slots empty' });

  const components = [];
  const labels = ['CT1 Paid', 'CT2 Paid', 'T Paid'];
  for (let i = 0; i < 3; i++) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rent_slot_${channel.id}_${i}`)
        .setLabel(labels[i])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!!system.slots[i])
    ));
  }

  try {
    await system.message.edit({ embeds: [embed], components });
  } catch {
    clearInterval(system.timer);
    RENT_SYSTEMS.delete(channel.id);
  }
}

function formatTime(ms) {
  const t = Math.floor(ms / 1000);
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function startTimerForChannel(channel) {
  const system = RENT_SYSTEMS.get(channel.id);
  if (!system) return;
  if (system.timer) clearInterval(system.timer);
  system.timer = setInterval(() => updateLobbyEmbed(channel), 1000);
}

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const ch = client.channels.cache.get(SIGNUP_CHANNEL_ID);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setColor('#00ff00')
    .setTitle('Welcome!')
    .setDescription(`<@${member.id}> **${member.user.tag}** joined!\n\nPlease send your **Steam profile link** in this channel:\n\n\`https://steamcommunity.com/profiles/99999999...\`\n\n**Example:**\nhttps://steamcommunity.com/profiles/99999999987654321\n\nAfter verification:\n• Nickname = Steam name\n• Get FARMERS role\n• All channels open\n\n**5 minutes timeout!**`)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setTimestamp();

  const msg = await ch.send({ embeds: [embed] });
  member.send({ embeds: [embed] }).catch(() => {});

  const timeout = setTimeout(async () => {
    if (PENDING_USERS.has(member.id)) {
      await member.kick('Timeout').catch(() => {});
      msg.delete().catch(() => {});
      PENDING_USERS.delete(member.id);
    }
  }, 300000);

  PENDING_USERS.set(member.id, { timeout, welcomeMessage: msg });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !PENDING_USERS.has(message.author.id)) return;

  const pending = PENDING_USERS.get(message.author.id);
  clearTimeout(pending.timeout);

  // Hem /profiles/ hem /id/ formatını kabul et + temizle
  const urlRegex = /https?:\/\/steamcommunity\.com\/(profiles\/(\d+)|id\/([^/\s]+))/;
  const match = message.content.match(urlRegex);

  if (!match) return message.reply('Wrong format! Send only: https://steamcommunity.com/profiles/... veya https://steamcommunity.com/id/...');

  let steamId64;

  if (match[2]) {
    // /profiles/7656... formatı
    steamId64 = match[2];
  } else if (match[3]) {
    // /id/kullaniciadi formatı → Steam API ile çöz
    const vanity = match[3];
    try {
      steamId64 = await steam.resolveVanityURL(vanity);
    } catch (err) {
      return message.reply('This custom URL not found or invalid. Send a valid Steam profile.');
    }
  }

  try {
    const profile = await steam.getUserSummary(steamId64);
    const member = await client.guilds.cache.get(GUILD_ID).members.fetch(message.author.id);

    await member.setNickname(profile.nickname).catch(() => {});
    await member.roles.add(VERIFIED_ROLE_ID);

    await message.reply(`**Verification successful!** Welcome **${profile.nickname}**!`);
    pending.welcomeMessage?.delete().catch(() => {});
    PENDING_USERS.delete(message.author.id);
  } catch (err) {
    console.log(err);
    message.reply('Invalid link or private profile. Try again with a public profile.');
  }
});

client.login(process.env.BOT_TOKEN);