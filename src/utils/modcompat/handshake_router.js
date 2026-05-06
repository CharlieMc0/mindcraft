// Routes login_plugin_request packets by channel name. Each registered handler
// is responsible for writing its own login_plugin_response. Channels with no
// registered handler get an empty "unsupported" reply plus a log line so we can
// see which gates the server expects.
//
// IMPORTANT: mineflayer's built-in plugin-channel handler in
// node_modules/minecraft-protocol/src/client/pluginChannels.js registers its OWN
// `login_plugin_request` listener that writes a success=false response for every
// request — i.e. tells the server "client didn't understand". Owo treats that as
// a failed handshake. To send our own structured response we MUST remove that
// built-in listener before attaching ours, otherwise the server sees success=false
// arrive first and kicks before our async response lands.

import { attachOwoResponder } from './owo_responder.js';
import { attachFrozenlibResponder } from './frozenlib_responder.js';

export function attachModCompat(bot, settings) {
    const client = bot._client;
    if (!client) return;

    if (settings.modpack) {
        // Strip mineflayer's "I don't understand" auto-responder. We own this event now.
        const before = client.listenerCount('login_plugin_request');
        client.removeAllListeners('login_plugin_request');
        const after = client.listenerCount('login_plugin_request');
        console.log(`[modcompat] removed ${before - after} built-in login_plugin_request listener(s)`);
    }

    const handled = new Set();

    if (settings.modpack) {
        attachOwoResponder(client, settings);
        handled.add('owo:handshake');
        attachFrozenlibResponder(client);
    }

    // Diagnostic + safety net for everything else.
    // Default ack: data=undefined → success=false on the wire. Most Fabric login
    // query handlers short-circuit on `if (!success) return;`. That avoids the
    // IndexOutOfBoundsException trap of sending success=true with an empty buffer
    // when the handler tries to read structured data (e.g. forgeconfigapiport
    // calls buf.readUtf which throws on empty input).
    client.on('login_plugin_request', (packet) => {
        if (handled.has(packet.channel)) return; // dedicated handler will respond
        const len = packet.data?.length ?? 0;
        console.log(`[modcompat] unhandled login_plugin_request channel=${packet.channel} msgId=${packet.messageId} len=${len}`);
        try {
            client.write('login_plugin_response', { messageId: packet.messageId, data: undefined });
        } catch (err) {
            console.warn(`[modcompat] failed to ack unhandled channel ${packet.channel}: ${err.message}`);
        }
    });

    client.on('custom_payload', (packet) => {
        // Post-login mod packets — purely diagnostic for now.
        console.log(`[modcompat] custom_payload channel=${packet.channel} len=${packet.data?.length ?? 0}`);
    });
}
