// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require('discord.js');

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const SUGGESTION_CHANNEL_ID = process.env.SUGGESTION_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PERSISTENT_DISK_PATH = process.env.PERSISTENT_DISK_PATH || '';
const SITE_TITLE = process.env.SITE_TITLE || 'Suggestion Bot';
const BRAND_COLOR = process.env.BRAND_COLOR || '#7c3aed';
const LOGO_URL = process.env.LOGO_URL || '';

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in env');
  process.exit(1);
}
if (!SUGGESTION_CHANNEL_ID) {
  console.error('Missing SUGGESTION_CHANNEL_ID in env');
  process.exit(1);
}

// choose DB path
const DB_DIR = PERSISTENT_DISK_PATH ? path.join(PERSISTENT_DISK_PATH) : __dirname;
const DB_FILE = path.join(DB_DIR, 'suggestions.db');

try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch(e){/*ignore*/}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.prepare(`CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  message_id TEXT,
  channel_id TEXT
)`).run();

/* ---------- Express website ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/site-info', (req, res) => {
  res.json({ siteTitle: SITE_TITLE, brandColor: BRAND_COLOR, logoUrl: LOGO_URL });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM suggestions').get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM suggestions WHERE status = 'Pending'").get().c;
  const approved = db.prepare("SELECT COUNT(*) as c FROM suggestions WHERE status = 'Approved'").get().c;
  res.json({ total, pending, approved });
});

app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

/* ---------- Discord bot ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction]
});

function formatSid(n){ return n.toString().padStart(3,'0'); }

function makeSuggestionEmbed(sid, content, authorTag, status) {
  const title = `💡 Suggestion #${formatSid(sid)}`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(content)
    .setColor(BRAND_COLOR)
    .addFields({ name: 'Status', value: status === 'Pending' ? '🟡 Pending Review' : (status === 'Approved' ? '✅ Approved' : '❌ Denied'), inline: true })
    .setFooter({ text: `Suggested by ${authorTag}` })
    .setTimestamp();
  return embed;
}

// DB helpers
function createSuggestion(authorId, authorTag, content, messageId, channelId){
  const stmt = db.prepare(`INSERT INTO suggestions (author_id, author_tag, content, message_id, channel_id) VALUES (?, ?, ?, ?, ?)`);
  const info = stmt.run(authorId, authorTag, content, messageId, channelId);
  return info.lastInsertRowid;
}
function updateStatus(sid, status){
  db.prepare(`UPDATE suggestions SET status = ? WHERE id = ?`).run(status, sid);
}
function getSuggestion(sid){
  return db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(sid);
}
function listSuggestions(limit=1000, offset=0, filter=null){
  if (filter && filter !== 'all'){
    return db.prepare(`SELECT id, author_tag, content, status, message_id FROM suggestions WHERE lower(status)=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(filter.toLowerCase(), limit, offset);
  } else {
    return db.prepare(`SELECT id, author_tag, content, status, message_id FROM suggestions ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }
}

// slash commands
const commands = [
  new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion').addStringOption(opt=>opt.setName('idea').setDescription('Your suggestion').setRequired(true)),
  new SlashCommandBuilder().setName('approve').setDescription('Approve a suggestion (manager only)').addIntegerOption(opt=>opt.setName('id').setDescription('Suggestion ID').setRequired(true)).addStringOption(opt=>opt.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('deny').setDescription('Deny a suggestion (manager only)').addIntegerOption(opt=>opt.setName('id').setDescription('Suggestion ID').setRequired(true)).addStringOption(opt=>opt.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('suggestions').setDescription('List suggestions (paginated)').addStringOption(opt=>opt.setName('filter').setDescription('Filter: all,pending,approved,denied')),
  new SlashCommandBuilder().setName('suggestion').setDescription('Show a suggestion by ID').addIntegerOption(opt=>opt.setName('id').setDescription('Suggestion ID').setRequired(true))
].map(c => c.toJSON());

async function registerCommands(){
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands((await client.application.fetch()).id, GUILD_ID), { body: commands });
      console.log('Registered commands to guild', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands((await client.application.fetch()).id), { body: commands });
      console.log('Registered global commands.');
    }
  } catch (err){
    console.error('Failed to register commands:', err);
  }
}

client.once('ready', async () => {
  console.log('Discord ready as', client.user.tag);
  await registerCommands();
});

// helper to build list embed
function buildListEmbed(rows, page, pageSize, filter) {
  const embed = new EmbedBuilder().setTitle(`Suggestions — ${filter ? filter[0].toUpperCase()+filter.slice(1): 'All'}`).setColor(BRAND_COLOR);
  const start = page * pageSize;
  const slice = rows.slice(start, start + pageSize);
  if (slice.length === 0) embed.setDescription('No suggestions to show on this page.');
  for (const r of slice) {
    const short = r.content.length > 120 ? r.content.slice(0,117) + '...' : r.content;
    embed.addFields({ name: `#${formatSid(r.id)} — ${r.status}`, value: `${short}\n*by ${r.author_tag}*` });
  }
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  embed.setFooter({ text: `Page ${page+1}/${pages} • Showing ${slice.length} of ${rows.length}` });
  return embed;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === 'suggest') {
        const idea = interaction.options.getString('idea', true);
        await interaction.deferReply({ ephemeral: true });

        const ch = await client.channels.fetch(SUGGESTION_CHANNEL_ID).catch(()=>null);
        if (!ch) return interaction.editReply({ content: '❌ Suggestion channel not found. Check SUGGESTION_CHANNEL_ID.', ephemeral: true });

        const placeholder = new EmbedBuilder().setTitle('💡 New Suggestion').setDescription(idea).addFields({ name:'Status', value:'🟡 Pending Review' }).setFooter({ text: `Suggested by ${interaction.user.tag}` }).setColor(BRAND_COLOR);
        const posted = await ch.send({ embeds: [placeholder] });
        await posted.react('👍'); await posted.react('👎');

        const sid = createSuggestion(interaction.user.id, interaction.user.tag, idea, posted.id, posted.channel.id);
        const finalEmbed = makeSuggestionEmbed(sid, idea, interaction.user.tag, 'Pending');
        await posted.edit({ embeds: [finalEmbed] });

        return interaction.editReply({ content: `✅ Suggestion posted as #${formatSid(sid)}`, ephemeral: true });
      }

      if (name === 'approve' || name === 'deny') {
        const id = interaction.options.getInteger('id', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({ content: '❌ You need Manage Server permission.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const row = getSuggestion(id);
        if (!row) return interaction.editReply({ content: 'Suggestion not found', ephemeral: true });

        const newStatus = (name === 'approve') ? 'Approved' : 'Denied';
        updateStatus(id, newStatus);
        try {
          const ch = await client.channels.fetch(row.channel_id);
          const msg = await ch.messages.fetch(row.message_id);
          const embed = makeSuggestionEmbed(id, row.content, row.author_tag, newStatus);
          embed.addFields({ name: `${newStatus} by`, value: interaction.user.tag }, { name: 'Reason', value: reason });
          await msg.edit({ embeds: [embed] });
        } catch (e) {
          console.warn('Could not edit message:', e.message);
        }
        return interaction.editReply({ content: `${newStatus === 'Approved' ? '✅' : '❌'} #${formatSid(id)} marked ${newStatus}`, ephemeral: true });
      }

      if (name === 'suggestions') {
        await interaction.deferReply();
        let filter = interaction.options.getString('filter') || 'all';
        filter = filter.toLowerCase();
        if (!['all','pending','approved','denied'].includes(filter)) filter = 'all';
        const rows = listSuggestions(1000, 0, filter === 'all' ? null : filter);
        const pageSize = 5;
        const page = 0;
        const embed = buildListEmbed(rows, page, pageSize, filter);
        const prev = new ButtonBuilder().setCustomId(`prev|${page}|${filter}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true);
        const next = new ButtonBuilder().setCustomId(`next|${page}|${filter}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(rows.length <= pageSize);
        const row = new ActionRowBuilder().addComponents(prev, next);
        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      if (name === 'suggestion') {
        const id = interaction.options.getInteger('id', true);
        await interaction.deferReply();
        const r = getSuggestion(id);
        if (!r) return interaction.editReply({ content: 'Suggestion not found', ephemeral: true });
        const embed = makeSuggestionEmbed(r.id, r.content, r.author_tag, r.status);
        embed.addFields({ name: 'Created At', value: r.created_at || 'Unknown', inline: true });
        try {
          const ch = await client.channels.fetch(r.channel_id);
          const msg = await ch.messages.fetch(r.message_id);
          let up = 0, down = 0;
          for (const reaction of msg.reactions.cache.values()){
            const name = reaction.emoji.name || reaction.emoji.toString();
            if (name === '👍') up = reaction.count - (reaction.me ? 1 : 0);
            if (name === '👎') down = reaction.count - (reaction.me ? 1 : 0);
          }
          embed.addFields({ name: 'Votes', value: `👍 ${up} | 👎 ${down}`, inline: true });
        } catch(e){}
        return interaction.editReply({ embeds: [embed] });
      }
    } // end commands

    if (interaction.isButton()) {
      const custom = interaction.customId; // format: action|curPage|filter
      const parts = custom.split('|');
      const action = parts[0];
      const curPage = parseInt(parts[1] || '0', 10);
      const filter = parts[2] || 'all';
      const rows = listSuggestions(1000, 0, filter === 'all' ? null : filter);
      const pageSize = 5;
      let newPage = curPage;
      if (action === 'prev') newPage = Math.max(0, curPage - 1);
      if (action === 'next') newPage = Math.min(Math.max(0, Math.ceil(rows.length / pageSize) - 1), curPage + 1);
      const embed = buildListEmbed(rows, newPage, pageSize, filter);
      const prev = new ButtonBuilder().setCustomId(`prev|${newPage}|${filter}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(newPage === 0);
      const next = new ButtonBuilder().setCustomId(`next|${newPage}|${filter}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled((newPage+1) * pageSize >= rows.length);
      const row = new ActionRowBuilder().addComponents(prev, next);
      await interaction.update({ embeds: [embed], components: [row] });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.replied || interaction.deferred) {
      try { await interaction.followUp({ content: 'An error occurred.', ephemeral: true }); } catch(e){}
    } else {
      try { await interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch(e){}
    }
  }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});
