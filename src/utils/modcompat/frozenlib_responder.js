// FrozenLib registry-sync handshake (server-to-client play state).
//
// Server flow (`ServerRegistrySyncNetworkHandler`):
//   1. constructor: send custom_payload `frozenlib:registry_sync/handshake` (versions)
//   2. constructor: send play.ping(id=0)
//   3. on incoming custom_payload: read varint version → store syncVersion field
//   4. on incoming pong(0): case 0 — if syncVersion supported, send sync packets;
//      send play.ping(id=1)
//   5. on incoming pong(1): case 1 — if syncVersion=-1 AND requiresSync():
//      KICK with empty text. Else: continueLogin → JOIN_GAME.
//
// The kick path triggers when our handshake reply hasn't reached the server
// before mineflayer's auto-pong(1) does. There's a real race because mineflayer
// auto-pongs every play.ping inside its game.js plugin and that runs ahead of
// any async reply we'd write from a custom_payload listener.
//
// Robust fix: don't wait for the server's hello at all. The protocol only has
// one supported client version (1) — pre-emptively send `varint(1)` on the
// `login` event, the moment the connection enters PLAY state. By the time
// frozenlib's hello + ping(0) round-trip, the server has already seen
// syncVersion=1 and the case-1 kick can never fire. Reply on any subsequent
// hello is also still sent (idempotent — just re-sets the same int) for safety.

import { decodeVarInt, encodeVarInt } from './codec.js';

// Server-to-client and client-to-server use DIFFERENT channels:
//   server → client: `frozenlib:registry_sync/handshake`           (Hello with versions list)
//   client → server: `frozenlib:registry_sync/handshake_client`    (chosen version varint)
//
// Confirmed against frozenlib bytecode:
//   ServerPackets$Handshake.<clinit>: id("registry_sync/handshake")
//   ClientPackets$Handshake.<clinit>: id("registry_sync/handshake_client")
const SERVER_HELLO_CHANNEL = 'frozenlib:registry_sync/handshake';
const CLIENT_REPLY_CHANNEL = 'frozenlib:registry_sync/handshake_client';
const ASSUMED_VERSION = 1;

export function attachFrozenlibResponder(client) {
    if (!client) return;

    // No pong gating. With server-side `forceDisable=true` (set by the
    // ChannelHashDumper mod), frozenlib's case-1 path falls through to
    // continueLogin even when syncVersion=-1, so the race is harmless. For a
    // server WITHOUT the bypass (e.g. friend's :25565), the pre-empt + echo
    // replies should still set syncVersion=1 first; if they don't, that's a
    // wire-ordering bug worth solving with packet capture rather than gating.

    let preempted = false;

    function sendReply(version, reason) {
        try {
            const out = encodeVarInt(version);
            client.write('custom_payload', { channel: CLIENT_REPLY_CHANNEL, data: out });
            console.log(`[frozenlib] sent handshake reply v=${version} (${reason})`);
        } catch (err) {
            console.error(`[frozenlib] write failed: ${err.message}`);
        }
    }

    // Pre-emptive: server's syncVersion field defaults to -1. We need our
    // handshake reply to reach the server BEFORE mineflayer's auto-pong on the
    // GOODBYE_PING (id=1), otherwise frozenlib's case-1 path kicks with empty
    // text. mineflayer's `play.js` registers `once('success', onLogin)` which
    // synchronously sets `client.state = states.PLAY`. Since plugins register
    // before us, by the time our handler fires the state is already PLAY and
    // the play-state schema is active for `client.write('custom_payload', ...)`.
    //
    // Write SYNCHRONOUSLY inside the 'success' handler — no setImmediate. Any
    // microtask or io tick between the LOGIN_SUCCESS read and our write lets
    // pending PLAY-state packets (frozenlib's hello + ping(0) + ping(1)) drain
    // through the deserializer first; mineflayer's auto-pong then races our
    // pre-empt onto the wire.
    client.once('success', () => {
        console.log(`[frozenlib] success event: client.state=${client.state}`);
        sendReply(ASSUMED_VERSION, 'pre-emptive on login_success');
        preempted = true;
    });

    // Reactive: if server's hello arrives, decode and reply with the highest
    // version it offers. Idempotent — server's method_12075 just stores the int.
    client.on('custom_payload', (packet) => {
        if (packet.channel !== SERVER_HELLO_CHANNEL) return;
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
    });
}
