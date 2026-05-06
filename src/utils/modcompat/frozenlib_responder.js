// FrozenLib registry-sync handshake (PLAY state).
//
// Two channels (asymmetric — confirmed against frozenlib bytecode):
//   server → client: frozenlib:registry_sync/handshake          (Hello with versions list)
//   client → server: frozenlib:registry_sync/handshake_client   (chosen version varint)
//
// Reply sent synchronously on the 'success' event so it lands ahead of
// mineflayer's auto-pong for the GOODBYE_PING. If the pong (id=1) reaches the
// server before our reply, frozenlib's case-1 path sees syncVersion=-1 +
// requiresSync=true and kicks with Component.empty() ({"text":""}).

import { decodeVarInt, encodeVarInt } from './codec.js';

const SERVER_HELLO_CHANNEL = 'frozenlib:registry_sync/handshake';
const CLIENT_REPLY_CHANNEL = 'frozenlib:registry_sync/handshake_client';
const ASSUMED_VERSION = 1;

export function attachFrozenlibResponder(client) {
    if (!client) return;

    let preempted = false;
    let helloHandled = false;

    function sendReply(version, reason) {
        try {
            const out = encodeVarInt(version);
            client.write('custom_payload', { channel: CLIENT_REPLY_CHANNEL, data: out });
            console.log(`[frozenlib] sent handshake reply v=${version} (${reason})`);
        } catch (err) {
            console.error(`[frozenlib] write failed: ${err.message}`);
        }
    }

    client.once('success', () => {
        sendReply(ASSUMED_VERSION, 'pre-emptive on login_success');
        preempted = true;
    });

    function onCustomPayload(packet) {
        if (packet.channel !== SERVER_HELLO_CHANNEL) return;
        if (helloHandled) return;
        helloHandled = true;
        client.removeListener('custom_payload', onCustomPayload);
        try {
            const buf = packet.data;
            if (!buf || buf.length === 0) return;
            let cursor = 0;
            const head = decodeVarInt(buf, cursor); cursor += head.bytes;
            const versions = [];
            for (let i = 0; i < head.value; i++) {
                const v = decodeVarInt(buf, cursor); cursor += v.bytes;
                versions.push(v.value);
            }
            const chosen = Math.max(...versions);
            console.log(`[frozenlib] hello received versions=${JSON.stringify(versions)}; pre-empted=${preempted}`);
            sendReply(chosen, preempted ? 'echo after pre-empt' : 'reactive (no pre-empt)');
        } catch (err) {
            console.error(`[frozenlib] responder error: ${err.stack || err.message}`);
        }
    }
    client.on('custom_payload', onCustomPayload);
}
