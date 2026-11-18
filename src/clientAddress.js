// Works out which address a request really came from.
//
// Behind a hosting platform's proxy every connection arrives from the proxy, so the raw
// address is the same for all visitors. The proxy passes the real one on in
// X-Forwarded-For — but a client can send that header too, with anything in it. Only the
// entries appended by proxies we run behind can be believed, and those are the last ones.
//
// `trustedHops` is how many such proxies there are. 0 (the default) ignores the header.
// With 1, the address is the last entry of the header: the one our proxy added.
export const clientAddress = ({ remoteAddress, forwardedFor } = {}, trustedHops = 0) => {
    const direct = normalise(remoteAddress) || 'unknown'
    if (!Number.isInteger(trustedHops) || trustedHops <= 0) return direct

    // Node joins repeated headers with ", ", so one string covers every case.
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : String(forwardedFor ?? '')
    const chain = header.split(',').map(normalise).filter(Boolean)
    // Oldest first: [whatever the client claimed…, entries added by proxies…, nearest proxy].
    chain.push(direct)

    // Fewer entries than proxies means the request did not come through all of them
    // (or the setting is too high): use the oldest entry there is rather than nothing.
    return chain[Math.max(0, chain.length - 1 - trustedHops)]
}

// "::ffff:203.0.113.5" and "203.0.113.5" are the same client.
const normalise = value => String(value ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')

export const addressOfSocket = (socket, trustedHops = 0) => clientAddress({
    remoteAddress: socket.handshake.address,
    forwardedFor: socket.handshake.headers['x-forwarded-for'],
}, trustedHops)
