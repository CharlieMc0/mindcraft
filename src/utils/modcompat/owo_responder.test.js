import test from 'node:test';
import assert from 'node:assert';
import { attachOwoResponder } from './owo_responder.js';
import { clearCache } from './bridge_client.js';
import { decodeMap } from './codec.js';
import http from 'node:http';

function startMockBridge(payload) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            if (req.url === '/owo/hashes') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(payload));
            } else {
                res.statusCode = 404;
                res.end();
            }
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

function makeFakeClient() {
    const listeners = {};
    let captured = null;
    return {
        on(event, cb) { listeners[event] = cb; },
        write(name, pkt) { captured = { name, pkt }; },
        emit(event, packet) { if (listeners[event]) listeners[event](packet); },
        get captured() { return captured; },
    };
}

test('owo responder writes correct 3-map wire format', async () => {
    clearCache();
    const payload = {
        requiredChannels: { 'things:main': 1564460769, 'friendsforlife:main': -156033108 },
        requiredControllers: {},
        optionalChannels: {},
    };
    const srv = await startMockBridge(payload);
    const port = srv.address().port;

    const fakeClient = makeFakeClient();
    attachOwoResponder(fakeClient, { modbridge_url: `http://127.0.0.1:${port}` });

    // Wait for prewarm fetch to finish (bridge mock may race).
    await new Promise((r) => setTimeout(r, 50));

    fakeClient.emit('login_plugin_request', { channel: 'owo:handshake', messageId: 0, data: Buffer.from([0]) });
    await new Promise((r) => setTimeout(r, 50));

    const captured = fakeClient.captured;
    assert.ok(captured, 'responder did not write login_plugin_response');
    assert.strictEqual(captured.name, 'login_plugin_response');
    assert.strictEqual(captured.pkt.messageId, 0);
    assert.ok(Buffer.isBuffer(captured.pkt.data), 'data is not a Buffer');

    const buf = captured.pkt.data;
    let cursor = 0;
    const m1 = decodeMap(buf, cursor); cursor += m1.bytes;
    const m2 = decodeMap(buf, cursor); cursor += m2.bytes;
    const m3 = decodeMap(buf, cursor); cursor += m3.bytes;
    assert.deepStrictEqual(m1.value, payload.requiredChannels);
    assert.deepStrictEqual(m2.value, payload.requiredControllers);
    assert.deepStrictEqual(m3.value, payload.optionalChannels);
    assert.strictEqual(cursor, buf.length, 'extra bytes in encoded response');

    srv.close();
});
