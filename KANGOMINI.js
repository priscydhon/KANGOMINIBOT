/* Kango - Complete WhatsApp Bot with Telegram Integration */
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    downloadContentFromMessage,
    getContentType,
    jidDecode,
    proto
} = require('@whiskeysockets/baileys'); 
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const FileType = require('file-type');
const { parsePhoneNumber } = require('libphonenumber-js');
const PhoneNumber = require('awesome-phonenumber');
const axios = require('axios');

// ==================== Configuration ====================

// Define a list of different browser fingerprints
const browserOptions = [
    Browsers.macOS('Safari'),
    Browsers.macOS('Chrome'),
    Browsers.windows('Firefox'),
    Browsers.ubuntu('Chrome'),
    Browsers.baileys('Baileys'), // Custom Baileys fingerprint
    Browsers.macOS('Edge'),
    Browsers.windows('Edge'),
];

// Choose one randomly
const randomBrowser = browserOptions[Math.floor(Math.random() * browserOptions.length)];

// Use it in your config
const config = {
    telegramToken: '7854884941:AAHwgAE_6neQiSi9QwbPm2VZ1N428QKTTok',
    ownerId: '5653368019',
    channelUsername: 'kangoxmd',
    menuImageUrl: 'https://i.imgur.com/pYYZeOr.jpeg',
    sessionDir: path.join(__dirname, 'kango_sessions'),
    mediaDir: path.join(__dirname, 'kango-media'),
    prefix: '!',
    maxFileSize: 100 * 1024 * 1024,
    reconnectDelay: 5000,
    browser: randomBrowser, // ⬅️ randomized here
};

// ==================== Utilities ====================
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const channelMemberCache = new NodeCache({ stdTTL: 60 });

// ==================== Store Implementation ====================
const store = {
    messages: new Map(),
    contacts: new Map(),
    groupMetadata: new Map(),
    
    loadMessage: async (jid, id) => {
        return store.messages.get(`${jid}:${id}`) || null;
    },
    
    bind: (ev) => {
        ev.on('messages.upsert', ({ messages }) => {
            messages.forEach(msg => {
                store.messages.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
            });
        });
    }
};

// ==================== Bot Initialization ====================
const bot = new TelegramBot(config.telegramToken, { polling: true });
const activeHectorBots = new Map();
let isFirstLog = true;

// ==================== Channel Verification ====================
async function checkUserInChannel(userId) {
    try {
        // Always allow owner
        if (userId.toString() === config.ownerId.toString()) return true;

        try {
            // Use getChatMember with channel username
            const chatMember = await bot.getChatMember(`@${config.channelUsername}`, userId);
            return ['member', 'administrator', 'creator'].includes(chatMember.status);
        } catch (error) {
            console.error('Channel check failed:', error.message);
            return false;
        }
    } catch (error) {
        console.error('Error in checkUserInChannel:', error);
        return false;
    }
}

async function checkAndRespond(msg, callback) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Owner bypass
    if (userId.toString() === config.ownerId.toString()) {
        return callback();
    }

    const isMember = await checkUserInChannel(userId);
    if (!isMember) {
        return bot.sendPhoto(chatId, config.menuImageUrl, {
            caption: `
╔══════════════════════╗   
*📌 To use our bot please complete channel verification first*
╚══════════════════════╝
`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🚀 Join Channel", url: `https://t.me/${config.channelUsername}` }],
                    [{ text: "✅ I've Joined", callback_data: "verify_join" }]
                ]
            }
        });
    }
    return callback();
}

// ==================== WhatsApp Connection Handler ====================
async function KangoStart(phoneNumber, telegramChatId = null) {
    try {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        if (isFirstLog) {
            console.log(`Using Baileys version: ${version} (Latest: ${isLatest})`);
            isFirstLog = false;
        }
    } catch (e) {
        console.log('Could not fetch latest Baileys version', e);
    }

    const sessionPath = path.join(config.sessionDir, `session_${phoneNumber}`);
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    if (activeHectorBots.has(phoneNumber)) {
        const existingConn = activeHectorBots.get(phoneNumber).Kango;
        if (existingConn && existingConn.user) {
            if (telegramChatId) {
                bot.sendMessage(telegramChatId, `✨ ${phoneNumber} Already Connected ✅ Type /delpair to Disconnect and Pair again!`);
            }
            return existingConn;
        } else {
            activeHectorBots.delete(phoneNumber);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const Kango = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: config.browser,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return store.loadMessage(key.remoteJid, key.id);
        }
    });

    activeHectorBots.set(phoneNumber, { 
        Kango, 
        telegramChatId,
        isNewConnection: true 
    });
    store.bind(Kango.ev);

    Kango.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const botData = activeHectorBots.get(phoneNumber);

        if (connection === 'open') {
            await saveCreds();
            
            if (telegramChatId && botData.isNewConnection) {
                bot.sendMessage(telegramChatId, `
╔═══❰ DEV MAX MD MINI ❱══✤
║ Connected successfully to
║${phoneNumber} 
╚═════════════════✤
`);
botData.isNewConnection = false;
                activeHectorBots.set(phoneNumber, botData);
            }
        } 
        else if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            
            if ([
                DisconnectReason.connectionClosed,
                DisconnectReason.connectionLost,
                DisconnectReason.connectionReplaced,
                DisconnectReason.restartRequired,
                DisconnectReason.timedOut
            ].includes(reason)) {
                setTimeout(() => KangoStart(phoneNumber, telegramChatId), config.reconnectDelay);
            } 
            else if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true });
                }
                if (telegramChatId) {
                    bot.sendMessage(telegramChatId, `⚠️ Session for ${phoneNumber} was removed (reason: ${DisconnectReason[reason]}) use /pair to connect again`);
                }
                activeHectorBots.delete(phoneNumber);
            }
        }
    });

    if (!Kango.authState.creds.registered && telegramChatId) {
        const pairingTimeout = setTimeout(async () => {
            try {
                const code = await Kango.requestPairingCode(phoneNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                bot.sendMessage(telegramChatId, `Pairing code for ${phoneNumber}:\n${formattedCode}`);
            } catch (err) {
                console.error('Pairing error:', err);
            }
        }, 3000);

        Kango.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                clearTimeout(pairingTimeout);
            }
        });
    }

    Kango.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;

            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage')
                ? mek.message.ephemeralMessage.message
                : mek.message;

            if (mek.key.remoteJid === 'status@broadcast') return;
            if (!Kango.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
            if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

            const currentBotNumber = Kango.user.id.split(':')[0];
            if (!activeHectorBots.has(currentBotNumber)) return;

            const m = smsg(Kango, mek, store);
            require("./kango1")(Kango, m, chatUpdate, store);
        } catch (err) {
            console.log('Message processing error:', err);
        }
    });

    Kango.ev.on('creds.update', saveCreds);

    Kango.decodeJid = (jid = '') => {
        if (!jid) return jid;
        const decoded = jidDecode(jid);
        if (decoded?.user && decoded?.server) {
            return `${decoded.user}@${decoded.server === 'lid' ? 's.whatsapp.net' : decoded.server}`;
        }
        return jid;
    };
  
    Kango.getName = (jid, withoutContact = false) => {
        const id = Kango.decodeJid(jid);
        withoutContact = Kango.withoutContact || withoutContact;
        let v;
        
        if (id.endsWith("@g.us")) {
            return new Promise(async (resolve) => {
                v = store.contacts.get(id) || {};
                if (!(v.name || v.subject)) {
                    v = await Kango.groupMetadata(id) || {};
                }
                const number = id.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                try {
                    const formatted = number ? parsePhoneNumber('+' + number).formatInternational() : 'Unknown';
                    resolve(v.name || v.subject || formatted);
                } catch {
                    resolve(v.name || v.subject || '+' + number);
                }
            });
        } else {
            v = id === '0@s.whatsapp.net' ? {
                id,
                name: 'WhatsApp'
            } : id === Kango.decodeJid(Kango.user.id) ?
                Kango.user :
                (store.contacts.get(id) || {});
            
            const number = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            try {
                const formatted = number ? parsePhoneNumber('+' + number).formatInternational() : 'Unknown';
                return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || formatted;
            } catch {
                return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || '+' + number;
            }
        }
    };

    Kango.public = true;
    Kango.serializeM = (m) => smsg(Kango, m, store);

    Kango.sendText = (jid, text, quoted = '', options) => 
        Kango.sendMessage(jid, { text: text, ...options }, { quoted });

    Kango.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        try {
            const quoted = message.msg ? message.msg : message;
            const mime = (message.msg || message).mimetype || '';
            const messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await(const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            
            const type = await FileType.fromBuffer(buffer);
            if (!fs.existsSync(config.mediaDir)) {
                fs.mkdirSync(config.mediaDir, { recursive: true });
            }
            
            const trueFileName = attachExtension 
                ? path.join(config.mediaDir, `${filename}.${type.ext}`) 
                : path.join(config.mediaDir, filename);
                
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        } catch (error) {
            console.error('Media download error:', error);
            throw error;
        }
    };

    return Kango;
}

function smsg(Kango, m, store) {
    if (!m) return m;
    let M = proto.WebMessageInfo;

    if (m.key) {
        m.id = m.key.id;
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');

        const actualSender = m.isGroup
            ? m.key.participant || m.participant || ''
            : m.key.remoteJid;

        m.sender = Kango.decodeJid(m.fromMe ? Kango.user.id : actualSender);
        if (m.isGroup) {
            m.participant = Kango.decodeJid(actualSender);
        }
    }

    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = m.mtype === 'viewOnceMessage'
            ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)]
            : m.message[m.mtype];

        m.body =
            m.message.conversation ||
            m.msg.caption ||
            m.msg.text ||
            (m.mtype === 'listResponseMessage' && m.msg.singleSelectReply.selectedRowId) ||
            (m.mtype === 'buttonsResponseMessage' && m.msg.selectedButtonId) ||
            (m.mtype === 'viewOnceMessage' && m.msg.caption) ||
            m.text;

        m.mentionedJid = m.msg?.contextInfo?.mentionedJid || [];

        if (m.msg.caption) {
            m.caption = m.msg.caption;
        }

        let quoted = m.quoted = m.msg?.contextInfo?.quotedMessage || null;
        if (m.quoted) {
            let type = getContentType(quoted);
            m.quoted = quoted[type];

            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted);
                m.quoted = m.quoted[type];
            }

            if (typeof m.quoted === 'string') m.quoted = { text: m.quoted };
            m.quoted.mtype = type;
            m.quoted.id = m.msg.contextInfo.stanzaId;
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
            m.quoted.isBaileys = m.quoted.id?.startsWith('BAE5') && m.quoted.id.length === 16;
            m.quoted.sender = Kango.decodeJid(m.msg.contextInfo.participant);
            m.quoted.fromMe = m.quoted.sender === Kango.decodeJid(Kango.user.id);
            m.quoted.text =
                m.quoted.text ||
                m.quoted.caption ||
                m.quoted.conversation ||
                m.quoted.contentText ||
                m.quoted.selectedDisplayText ||
                m.quoted.title ||
                '';
            m.quoted.mentionedJid = m.msg.contextInfo?.mentionedJid || [];

            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id) return false;
                let q = await store.loadMessage(m.chat, m.quoted.id, Kango);
                return smsg(Kango, q, store);
            };

            let vM = m.quoted.fakeObj = M.fromObject({
                key: {
                    remoteJid: m.quoted.chat,
                    fromMe: m.quoted.fromMe,
                    id: m.quoted.id,
                },
                message: quoted,
                ...(m.isGroup ? { participant: m.quoted.sender } : {}),
            });

            m.quoted.delete = () => Kango.sendMessage(m.quoted.chat, { delete: vM.key });
            m.quoted.copyNForward = (jid, forceForward = false, options = {}) =>
                Kango.copyNForward(jid, vM, forceForward, options);
            m.quoted.download = () => Kango.downloadMediaMessage(m.quoted);
        }
    }

    if (m.msg?.url) {
        m.download = () => Kango.downloadMediaMessage(m.msg);
    }

    m.text =
        m.msg?.text ||
        m.msg?.caption ||
        m.message?.conversation ||
        m.msg?.contentText ||
        m.msg?.selectedDisplayText ||
        m.msg?.title ||
        '';

    m.reply = (text, chatId = m.chat, options = {}) =>
        Buffer.isBuffer(text)
            ? Kango.sendMedia(chatId, text, 'file', '', m, { ...options })
            : Kango.sendText(chatId, text, m, { ...options });

    m.copy = () => smsg(Kango, M.fromObject(M.toObject(m)));

    m.copyNForward = (jid = m.chat, forceForward = false, options = {}) =>
        Kango.copyNForward(jid, m, forceForward, options);

    return m;
}

// ==================== Telegram Commands ====================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    // Owner gets special menu
    if (userId.toString() === config.ownerId.toString()) {
        return bot.sendPhoto(chatId, config.menuImageUrl, {
            caption: `
╔════❰ OWNER MENU ❱════✤
╠❖  🎲 Available Commands:
╠❖  /pair <number> - Connect WhatsApp
╠❖  /delpair <number> - Disconnect
╠❖  /listpair - ᴏɴʟʏ ᴅᴇᴠ 😊
╚════════════════════✤
`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📢 Channel", url: `https://t.me/${config.channelUsername}` }]
                ]
            }
        });
    }

    // For regular users
    const isMember = await checkUserInChannel(userId);
    
    if (!isMember) {
        return bot.sendPhoto(chatId, config.menuImageUrl, {
            caption: `
╔════❰ 𝐃𝐄𝐕 𝐌𝐀𝐗 𝐌𝐈𝐍𝐈 ❱═══✤
║
║ ★  Click the button below to join our
║channel first befor getting access
║to our bot!
╚═════════════════════✤
`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🚀 Join Channel", url: `https://t.me/${config.channelUsername}` }],
                    [{ text: "✅ I've Joined", callback_data: "verify_join" }]
                ]
            }
        });
    }

    bot.sendPhoto(chatId, config.menuImageUrl, {
        caption: `
╔════❰ 𝐃𝐄𝐕 𝐌𝐀𝐗 𝐌𝐈𝐍𝐈 ❱═══✤
╠❖  🎲 Available Commands:
╠❖  /pair <number> - Connect WhatsApp
╠❖  /delpair <number> - Disconnect
╠❖  /listpair - ᴏɴʟʏ ᴅᴇᴠ 😊
╚═════════════════════✤
`,
        reply_markup: {
            inline_keyboard: [
                [{ text: "📢 Channel", url: `https://t.me/${config.channelUsername}` }]
            ]
        }
    });
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const chatId = msg.chat.id;

    if (callbackQuery.data === 'verify_join') {
        // Owner doesn't need verification
        if (userId.toString() === config.ownerId.toString()) {
            return bot.answerCallbackQuery(callbackQuery.id, {
                text: "Owner access granted!",
                show_alert: true
            });
        }

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: "Checking channel membership...",
            show_alert: false
        });

        // Force fresh check
        channelMemberCache.del(userId);
        
        const isMember = await checkUserInChannel(userId);
        
        if (isMember) {
            try {
                await bot.editMessageText({
                    chat_id: chatId,
                    message_id: msg.message_id,
                    text: `
✅ Verification successful! You can now use the bot commands.
`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🚀 Start Using Bot", callback_data: "show_commands" }]
                        ]
                    }
                });
            } catch (editError) {
                await bot.sendPhoto(chatId, config.menuImageUrl, {
                    caption: `
╔═══❰ 𝐃𝐄𝐕 𝐌𝐀𝐗 𝐌𝐈𝐍𝐈 ❱═══✤
║  ✅ Verification successful!
║ You can now acces all 
║ bot commands
║ Use /start to continue....
╚═══════════════════✤`
                });
            }
        } else {
            // Send warning message in chat
            await bot.sendMessage(chatId, `⚠️ Verification Check failed Make sure you have joined channel to pass verification and continue using the bot`, {
                reply_to_message_id: msg.message_id
            });
            
            // Show alert to user
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "You haven't joined the channel yet. Please join first!",
                show_alert: true
            });
        }
    }
    
    if (callbackQuery.data === 'show_commands') {
        try {
            await bot.editMessageText({
                chat_id: chatId,
                message_id: msg.message_id,
                text: `
╔═════❰ 𝐃𝐄𝐕 𝐌𝐀𝐗 𝐌𝐈𝐍𝐈 ❱═══✤
╠❖  🎲 Available Commands:
╠❖  /pair <number> - Connect WhatsApp
╠❖  /delpair <number> - Disconnect
╠❖  /listpair - ᴏɴʟʏ ᴅᴇᴠ 😊
╚══════════════════════✤
`,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📢 Channel", url: `https://t.me/${config.channelUsername}` }]
                    ]
                }
            });
        } catch (e) {
            await bot.sendPhoto(chatId, config.menuImageUrl, {
                caption: `
╔════❰ 𝐃𝐄𝐕 𝐌𝐀𝐗 𝐌𝐈𝐍𝐈 ❱═══✤
╠❖  🎲 Available Commands:
╠❖  /pair <number> - Connect WhatsApp
╠❖  /delpair <number> - Disconnect
╠❖  /listpair - ᴏɴʟʏ ᴅᴇᴠ 😊
╚═════════════════════✤
`
            });
        }
    }
});
bot.onText(/\/pair(?:\s+(\d+))?/, async (msg, match) => {
    await checkAndRespond(msg, async () => {
        const phoneNumber = match[1];
        const chatId = msg.chat.id;
        
        if (!phoneNumber) {
            return bot.sendPhoto(chatId, config.menuImageUrl, {
                caption: `
╔═════════════════════╗
 🚀 To connect Your Whatsapp
 Use /pair 2567079349....
 ✅ Replace 2567079349...
 With your Whatsapp Number
╚═════════════════════╝
`
            });
        }

        if (!/^\d+$/.test(phoneNumber)) {
            return bot.sendMessage(chatId, '⚠️ Invalid phone number format. Use numbers only like 2567079349....');
        }

        if (activeHectorBots.has(phoneNumber)) {
            const existingConn = activeHectorBots.get(phoneNumber).Kango;
            if (existingConn && existingConn.user) {
                return bot.sendMessage(chatId, `⚠️ ${phoneNumber} is already connected to DEV_MAX-MINI. Use /delpair to disconnect first!`);
            } else {
                activeHectorBots.delete(phoneNumber);
            }
        }

        bot.sendMessage(chatId, `🔄  DEV_MAX-MINI Generating Pairing... for ${phoneNumber}...`);

        try {
            await KangoStart(phoneNumber, chatId);
        } catch (err) {
            console.error('Pair command error:', err);
            bot.sendMessage(chatId, `❌ Failed to create session: ${err.message}`);
        }
    });
});

bot.onText(/\/delpair(?:\s+(\d+))?/, async (msg, match) => {
    await checkAndRespond(msg, async () => {
        const phoneNumber = match[1];
        const chatId = msg.chat.id;

        if (!phoneNumber) {
            return bot.sendPhoto(chatId, config.menuImageUrl, {
                caption: `
╔═════════════════════╗
 ⚠️ To discomnect Your Whatsapp
 Use /pair 2567079349....
 ✅ Replace 2567079349...
 With your Whatsapp Number
╚═════════════════════╝
`
            });
        }

        if (!/^\d+$/.test(phoneNumber)) {
            return bot.sendMessage(chatId, '⚠️ Invalid phone number format. Use numbers only like 2567079349...');
        }

        try {
            if (activeHectorBots.has(phoneNumber)) {
                activeHectorBots.get(phoneNumber).Kango.ws.close();
                activeHectorBots.delete(phoneNumber);
            }

            const sessionPath = path.join(config.sessionDir, `session_${phoneNumber}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                bot.sendMessage(chatId, `✅ Deleted DEV_MAX-MD session for ${phoneNumber}`);
            } else {
                bot.sendMessage(chatId, `⚠️ No session found for ${phoneNumber}`);
            }
        } catch (err) {
            console.error('Delpair command error:', err);
            bot.sendMessage(chatId, `❌ Failed to delete session: ${err.message}`);
        }
    });
});

bot.onText(/\/listpair/, async (msg) => {
    await checkAndRespond(msg, () => {
        const chatId = msg.chat.id;
        
        if (msg.from.id.toString() !== config.ownerId.toString()) {
            return bot.sendMessage(chatId, '❌ This command is for owner only');
        }

        try {
            let response = '📱 Active DEV_MAX-MINI Sessions:\n';
            activeHectorBots.forEach((session, number) => {
                response += `- ${number} (Chat ID: ${session.telegramChatId || 'N/A'})\n`;
            });
            bot.sendMessage(chatId, response || 'No active sessions');
        } catch (err) {
            console.error('Listpair command error:', err);
            bot.sendMessage(chatId, '❌ Failed to list sessions');
        }
    });
});

// ==================== Initialization ====================
async function initializeHectorBots() {
    try {
        if (!fs.existsSync(config.sessionDir)) {
            fs.mkdirSync(config.sessionDir, { recursive: true });
            console.log('Session directory created');
            return;
        }

        const sessions = fs.readdirSync(config.sessionDir)
            .filter(dir => dir.startsWith('session_'))
            .map(dir => dir.replace('session_', ''));
        
        if (sessions.length === 0) {
            console.log('No existing sessions found');
            return;
        }

        console.log(`Found ${sessions.length} session(s) to initialize`);
        
        const connectionPromises = sessions.map(number => 
            KangoStart(number)
                .then(() => console.log(`✅ Auto-connected to ${number}`))
                .catch(() => {})
        );

        await Promise.all(connectionPromises);
        
    } catch (error) {
        console.error('Initialization error:', error.message);
    }
}

initializeHectorBots().then(() => {
    console.log('🚀 KANGO-XMD MINI ready');
});

// ==================== File Watcher ====================
const file = require.resolve(__filename);
fs.watchFile(file, { interval: 1000 }, () => {
    fs.unwatchFile(file);
    console.log('🔄 Reloading...');
    delete require.cache[file];
    require(file);
});

// ==================== Error Handlers ====================
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err.message);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
    process.exit(1);
});