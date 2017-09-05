// Import modules
const MongoClient = require('mongodb').MongoClient;
const TelegramBot = require('node-telegram-bot-api');
// Import
//const config = require('./config');
// Import filter functions
const groupConfig = require('./lib/filters').groupConfig;
const filterReducer = require('./lib/filters').filterReducer;

let mongoGroups, mongoMessages;
const token = process.env.BOT_TOKEN || require('./config').bot_token
const mongoConection = process.env.MONGO_CONNECTION || require('./config').mongo_connection
let options = {}
if (process.env.APP_URL) {
    console.log("using webhooks, " + process.env.APP_URL)
    options = {
        webHook: {
            port: process.env.PORT
        }
    }
}
else {
    console.log("using longpoll")
    options = {
        polling: {
            autoStart: false
        }
    }
}

const bot = new TelegramBot(token, options) //
let me
// Load databases and then start bot
MongoClient.connect(mongoConection)
    .then(function (db) { // first - connect to database
        mongoGroups = db.collection('groups');
        mongoMessages = db.collection('messages');
        mongoMessages.createIndex({ postedDate: 1 }, { expireAfterSeconds: 10 })
            .then(async () => {
                let url = process.env.APP_URL
                if (url) {
                    console.log('hookin')
                    bot.setWebHook(`${url}/bot${token}`)
                } else {
                    console.log('pollin')
                    me = await bot.getMe()
                    bot.startPolling()

                }
            })
    })
    .catch((e) => {
        console.log(`FATAL :: ${e}`);
    });

// Bot reaction on commands "/config"
bot.onText(/\/config/, async function (msg, match) { // request configuration keyboard to PM
    //console.dir(me)
    if (match && msg.chat.type === 'supergroup') { // match must be not null (?)

        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }) // remove message with /cmd in supergroups

        let admins = await bot.getChatAdministrators(msg.chat.id) // get list of admins
        console.dir(admins)
        if (admins.filter(x => x.user.id == msg.from.id).length > 0) { // if sender is admin
            let alertMsg = ""
            let needPromotion = false
            let myAdminRights = admins.filter(x => x.user.id == me.id).length > 0 ? admins.filter(x => x.user.id == me.id)[0] : null

            if (!myAdminRights || !(myAdminRights.can_delete_messages && myAdminRights.can_restrict_members)) {
                needPromotion = true
            }

            if (needPromotion) {
                alertMsg = "\n_Bot have not enougth rights in this group! Promote him to admin, grant 'delete messages' and 'ban users' rights!_"
                bot.sendMessage(msg.from.id, `${alertMsg}`, { // and sent it
                    parse_mode: "markdown",
                });
            } else {
                let kbd = await getConfigKeyboard(msg.chat.id) // prepare keyboard
                bot.sendMessage(msg.from.id, `*${msg.chat.title}* configuration`, { // and sent it
                    parse_mode: "markdown",
                    reply_markup: kbd
                });
            }
        }
    } else if (msg.chat.type === 'private') {
        bot.sendMessage(msg.chat.id, "You sould use this command in supergroups that you want to configure");
    }
})

bot.onText(/\/start/, function (msg) {
    bot.sendMessage(msg.from.id, "Well done! You can use /help command to get some documentation.")
})

bot.onText(/\/help/, function (msg) {
    let text = `*IMPORTANT*
This bot can work only in supergroups for now!

To configure bot in your group you need:
    1) Invite bot to your group.
    2) Promote him to admin (check all except "add new admin")
    3) Configure bot by sending /config right into your group (message will disappear immediately).

*Why should you send a message to the group but not private?*
This is telegram limitation. In situation when you have couple of groups and want to configure one, bot cannot know which group you want to configure. So you need explicitly point it. Message will appear for moment, it wont interrupt chat members discussion.
`

    bot.sendMessage(msg.from.id, text, { // and sent it
        parse_mode: "markdown"
    })
})

// Bot messages monitoring
bot.on('message', async (msg) => {
    if (msg.chat.type !== 'supergroup') return; //we can delete messages only from supergroups 

    let cfg = await mongoGroups.findOne({ groupId: msg.chat.id }) // load group configuration
    mongoMessages.insertOne(messageEntry(msg.from.id, msg.chat.id))
    if (filterReducer(msg, cfg)) {
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { })
    } else { //spam
        if (cfg.restrictSpam)
            await checkIfSpam(msg)
    }

    console.dir(msg) // debug output
})

// Buttons responce in menu
bot.on('callback_query', async query => {
    let groupId = Number(query.data.split("#")[0])
    let prop = query.data.split("#")[1] // get info from button
    let g = await mongoGroups.findOne({ groupId: groupId })

    let val = !g[prop] // switch selected button
    await mongoGroups.updateOne({ groupId: groupId }, { $set: { [prop]: val } })

    let cb = await bot.answerCallbackQuery({ callback_query_id: query.id }) // store switched value

    let kbd = await getConfigKeyboard(groupId)// update keyboard

    bot.editMessageReplyMarkup(kbd, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
    })
})

async function checkIfSpam(msg) {

    let entry = messageEntry(msg.from.id, msg.chat.id, { $gte: new Date((new Date()).getTime() - 10 * 1000) })
    let count = await mongoMessages.count(entry)

    if (count > 5)
        restrictSpammer(msg)
}

async function getConfigKeyboard(chatId) { // prepare config keyboard		

    let res = await mongoGroups.findOne({ groupId: chatId })

    if (res === undefined || res.length === 0) {
        let g = groupConfig(chatId)
        await mongoGroups.insertOne(g)
        return getSetOfKeys(g)
    } else {
        return getSetOfKeys(res)
    }


}

// Return keyboard preset
function getSetOfKeys(groupConfig) {
    return {
        inline_keyboard: [
            [{
                text: `${groupConfig.joinedMsg ? "✔️" : "❌"} | delete 'joined' messages`,
                callback_data: `${groupConfig.groupId}#joinedMsg`
            }], [{
                text: `${groupConfig.pinnedMsg ? "✔️" : "❌"} | delete 'pinned' messages`,
                callback_data: `${groupConfig.groupId}#pinnedMsg`
            }], [{
                text: `${groupConfig.arabicMsg ? "✔️" : "❌"} | delete arabic messages`,
                callback_data: `${groupConfig.groupId}#arabicMsg`
            }], [{
                text: `${groupConfig.urlMsg ? "✔️" : "❌"} | delete messages with urls`,
                callback_data: `${groupConfig.groupId}#urlMsg`
            }], [{
                text: `${groupConfig.deleteCommands ? "✔️" : "❌"} | delete messages with commands`,
                callback_data: `${groupConfig.groupId}#deleteCommands`
            }], [{
                text: `${groupConfig.restrictSpam ? "✔️" : "❌"} | restrict spam`,
                callback_data: `${groupConfig.groupId}#restrictSpam`
            }]
        ]
    }
}

function restrictSpammer(msg) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { })
}

function messageEntry(userid, groupId, date) {
    return {
        postedDate: date || new Date(),
        userId: userid,
        groupId: groupId
    }
}
