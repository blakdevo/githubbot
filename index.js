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

    // diğer komutlar (clear, book, setupreservation, setupsignup) tamamen aynı kaldı, kısalttım
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('join_event_')) {
      const eventId = interaction.customId.split('_')[2];
      const event = EVENTS.get(eventId);

      // BURASI DEĞİŞTİ → SADECE EVENT YOKSA KAPAT
      if (!event) return interaction.reply({ content: 'Etkinlik kapandı veya silindi.', ephemeral: true });

      if (event.participants.includes(interaction.user.id)) return interaction.reply({ content: 'Zaten katıldın!', ephemeral: true });
      if (event.participants.length >= event.maxSlots) return interaction.reply({ content: 'Lobby dolu!', ephemeral: true });
      if (!interaction.member.roles.cache.some(r => r.name === FARMERS_ROLE)) return interaction.reply({ content: 'Sadece FARMERS!', ephemeral: true });

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
      await interaction.followUp({ content: `✅ <@${interaction.user.id}> katıldı! (${event.participants.length}/${event.maxSlots})`, ephemeral: false });
    }

    // rent_slot_, approve_, deny_, book_button vs. hepsi tamamen aynı kaldı
  }

  // modal submit vs. aynı
});

async function autoStartRentSystem(eventId) {
  const event = EVENTS.get(eventId);
  if (!event) return;

  const channel = client.channels.cache.get(event.channelId);
  if (!channel) return;

  if (event.participants.length === 0) {
    await channel.send(`Event "${event.name}" iptal edildi — kimse katılmadı.`);
    EVENTS.delete(eventId); // bu satır kalabilir, sorun yok ama join butonu zaten dolmazsa çalışmaz
    return;
  }

  await channel.send(`**EVENT BAŞLADI!** "${event.name}"\nKatılımcılar: ${event.participants.map(id => `<@${id}>`).join(', ')}\nRent sistemi aktif ediliyor...`);
  await createRentSystem(channel, [null, null, null]);

  // EVENTS.delete(eventId); → BU SATIRI YORUMA ALDIK!
  // Artık event silinmiyor → Join Lobby butonu sonsuza kadar (ya da lobby dolana kadar) aktif kalıyor
  // Rent sistemi tamamen normal çalışıyor, hiçbir şey bozulmuyor
}

// TÜM DİĞER FONKSİYONLAR (createRentSystem, updateLobbyEmbed, formatTime, parseTimeInput, createEventEmbed vs.) TAMAMEN AYNI KALDI

client.login(process.env.BOT_TOKEN);
