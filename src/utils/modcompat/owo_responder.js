// Owo handshake responder. Listens on the `owo:handshake` login_plugin_request
// channel, fetches matching channel/controller hashes from the bridge,
// encodes the 3-map HandshakeResponse per owo's wire spec, and writes
// the login_plugin_response packet.

import { fetchOwoHashes } from './bridge_client.js';
import { decodeOwoHandshakeRequest, encodeOwoHandshakeResponse } from './codec.js';

const CHANNEL = 'owo:handshake';

export function attachOwoResponder(client, settings) {
    if (!client) return;
    const baseUrl = settings.modbridge_url || 'http://localhost:7474';

    // Pre-warm the cache so the first handshake doesn't pay HTTP latency
    // inside the network thread.
    fetchOwoHashes(baseUrl).then((h) => {
        const sizes = [
            Object.keys(h.requiredChannels || {}).length,
            Object.keys(h.requiredControllers || {}).length,
            Object.keys(h.optionalChannels || {}).length,
        ];
        console.log(`[owo] bridge hashes loaded: required=${sizes[0]} controllers=${sizes[1]} optional=${sizes[2]}`);
    }).catch((err) => console.warn(`[owo] prewarm failed: ${err.message}`));

    client.on('login_plugin_request', (packet) => {
        if (packet.channel !== CHANNEL) return;
        respond(client, baseUrl, packet).catch((err) => {
            console.error(`[owo] responder error: ${err.message}`);
            // Best-effort: send empty response so server doesn't hang waiting.
            try {
                client.write('login_plugin_response', { messageId: packet.messageId, data: undefined });
            } catch (_) {}
        });
    });
}

async function respond(client, baseUrl, packet) {
    const req = decodeOwoHandshakeRequest(packet.data);
    const optKeys = Object.keys(req.optionalChannels || {});
    console.log(`[owo] request msgId=${packet.messageId} server-optional=${optKeys.length}`);

    const hashes = await fetchOwoHashes(baseUrl);
    const response = {
        requiredChannels: hashes.requiredChannels || {},
        requiredControllers: hashes.requiredControllers || {},
        optionalChannels: hashes.optionalChannels || {},
    };
    const data = encodeOwoHandshakeResponse(response);
    console.log(`[owo] writing response: required=${Object.keys(response.requiredChannels).length} `
        + `controllers=${Object.keys(response.requiredControllers).length} `
        + `optional=${Object.keys(response.optionalChannels).length} (${data.length} bytes)`);
    if (process.env.OWO_DEBUG_HEX === '1') {
        console.log(`[owo] bytes hex=${data.toString('hex')}`);
    }
    client.write('login_plugin_response', { messageId: packet.messageId, data });
}
