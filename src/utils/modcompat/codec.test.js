import test from 'node:test';
import assert from 'node:assert';
import {
    encodeVarInt, decodeVarInt,
    encodeString, decodeString,
    encodeMap, decodeMap,
    encodeOwoHandshakeResponse, decodeOwoHandshakeRequest,
} from './codec.js';

test('varint round-trip 0', () => {
    const b = encodeVarInt(0);
    assert.deepStrictEqual([...b], [0]);
    assert.strictEqual(decodeVarInt(b).value, 0);
});

test('varint round-trip 127', () => {
    const b = encodeVarInt(127);
    assert.deepStrictEqual([...b], [127]);
    assert.strictEqual(decodeVarInt(b).value, 127);
});

test('varint round-trip 128', () => {
    const b = encodeVarInt(128);
    assert.deepStrictEqual([...b], [0x80, 0x01]);
    assert.strictEqual(decodeVarInt(b).value, 128);
});

test('varint round-trip large', () => {
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 0x7fffffff, 0x10000, -1 >>> 0 & 0x7fffffff]) {
        const b = encodeVarInt(n);
        assert.strictEqual(decodeVarInt(b).value, n | 0, `n=${n}`);
    }
});

test('string round-trip ascii', () => {
    const b = encodeString('things:main');
    const d = decodeString(b);
    assert.strictEqual(d.value, 'things:main');
    assert.strictEqual(d.bytes, b.length);
});

test('string round-trip utf-8', () => {
    const s = 'мод:тест';
    const b = encodeString(s);
    assert.strictEqual(decodeString(b).value, s);
});

test('varint negative round-trip (5 bytes)', () => {
    const b = encodeVarInt(-156033108);
    assert.strictEqual(b.length, 5);
    assert.strictEqual(decodeVarInt(b).value, -156033108);
});

test('map round-trip', () => {
    const m = { 'things:main': 1564460769, 'friendsforlife:main': -156033108 };
    const b = encodeMap(m);
    const d = decodeMap(b);
    assert.deepStrictEqual(d.value, m);
});

test('empty map encodes as single zero byte (varint 0)', () => {
    const b = encodeMap({});
    assert.deepStrictEqual([...b], [0]);
});

test('owo response 3-map', () => {
    const buf = encodeOwoHandshakeResponse({
        requiredChannels: { 'a:b': 1 },
        requiredControllers: {},
        optionalChannels: { 'c:d': -2, 'e:f': 3 },
    });
    // map1: varint(1)+string("a:b")+int32(1) = 1 + (1+3) + 4 = 9
    // map2: varint(0) = 1
    // map3: varint(2)+...+...
    // First byte should be 1.
    assert.strictEqual(buf[0], 1);
});

test('owo request decode empty', () => {
    const r = decodeOwoHandshakeRequest(Buffer.from([0]));
    assert.deepStrictEqual(r.optionalChannels, {});
});
