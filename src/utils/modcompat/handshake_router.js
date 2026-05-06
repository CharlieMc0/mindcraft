// Routes login_plugin_request packets by channel name. Each registered handler
// is responsible for writing its own login_plugin_response. Channels with no
// registered handler get a success=false reply (data: undefined) so server-side
// Fabric handlers short-circuit on `if (!success) return;`.
//
// Mineflayer ships a built-in `login_plugin_request` listener in
// node_modules/minecraft-protocol/src/client/pluginChannels.js that auto-replies
// success=false for every request. Owo treats that as "client did not respond"
// and kicks. Strip it before attaching ours.

import { attachOwoResponder } from './owo_responder.js';
import { attachFrozenlibResponder } from './frozenlib_responder.js';

const PAYLOAD_LOG = process.env.MODCOMPAT_DEBUG === '1';

export function attachModCompat(bot, settings) {
    const client = bot._client;
    if (!client) return;

    if (!settings.modpack) {
        // Vanilla path: no compat layer. Mineflayer's built-in handler stays;
        // bot replies success=false to whatever it doesn't understand.
        return;
    }

    const before = client.listenerCount('login_plugin_request');
    client.removeAllListeners('login_plugin_request');
    console.log(`[modcompat] removed ${before} built-in login_plugin_request listener(s)`);

    attachOwoResponder(client, settings);
    attachFrozenlibResponder(client);
    const handled = new Set(['owo:handshake']);

    client.on('login_plugin_request', (packet) => {
        if (handled.has(packet.channel)) return;
        const len = packet.data?.length ?? 0;
        console.log(`[modcompat] unhandled login_plugin_request channel=${packet.channel} msgId=${packet.messageId} len=${len}`);
        try {
            client.write('login_plugin_response', { messageId: packet.messageId, data: undefined });
        } catch (err) {
            console.warn(`[modcompat] failed to ack unhandled channel ${packet.channel}: ${err.message}`);
        }
    });

    if (PAYLOAD_LOG) {
        // Post-login mod packets are spammy on a heavy modpack; gate the per-packet
        // log behind MODCOMPAT_DEBUG=1.
        client.on('custom_payload', (packet) => {
            console.log(`[modcompat] custom_payload channel=${packet.channel} len=${packet.data?.length ?? 0}`);
        });
    }
}
