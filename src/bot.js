// The demo bot: a user that exists only on the server, is always online, and replies.
// It is there so that someone who opens the demo alone has somebody to talk to. To every
// client it looks like any other online user — nothing in the protocol is special-cased.

export const BOT = Object.freeze({ username: 'demo-bot', id: 'demo-bot' })

/** Long enough to read as a reply rather than an echo. */
export const BOT_REPLY_DELAY_MS = 600

const ECHO_LIMIT = 80

// Every line states something the app really does.
const TIPS = [
    "I'm a bot that lives on the server, so there is always someone here to talk to. Send me anything.",
    "Your message was saved before I answered it. Reload the page and this conversation will still be here.",
    "Messages here go to exactly one person. Open this page in a second tab, join with another name, and the two of you can talk.",
    "If the connection drops, the app reconnects and signs you back in by itself, then catches up on anything it missed.",
    "If a message cannot be delivered you will see the reason under it. Nothing is dropped silently.",
    "Anyone can join this demo, so please don't share anything private. To keep your name, create an account from the menu on your name.",
]

// "@demo-bot", as a word of its own, in any case.
const MENTION = new RegExp(`(^|[^A-Za-z0-9_@-])@${BOT.username}(?![A-Za-z0-9_-])`, 'gi')

/** Whether a message in a group is addressed to the bot. */
export const mentionsBot = text => String(text).search(MENTION) !== -1

/** The message without the bot's name in it: what it is answering. */
export const withoutBotMention = text => String(text).replace(MENTION, '$1 ').trim()

/**
 * The bot's answer to `text`. Pure: the same text and turn always give the same reply.
 * `turn` is how many replies this user has already had, and walks through the tips.
 */
export const botReply = (text, turn = 0) => {
    const tip = TIPS[Math.abs(Math.trunc(turn)) % TIPS.length]
    const said = String(text).trim().replace(/\s+/g, ' ')

    // (Nothing but the bot's name, in a group, is a greeting too.)
    if (said === '' || /^(hi|hello|hey|hola|yo)\b/i.test(said)) {
        return `Hello! ${tip}`
    }

    const echo = said.length > ECHO_LIMIT ? `${said.slice(0, ECHO_LIMIT)}…` : said
    return `You said “${echo}”. ${tip}`
}
