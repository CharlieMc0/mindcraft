// Pure-JS encoders/decoders for the Minecraft + owo wire format pieces we
// need at login time. No mineflayer deps; transport only.

/** Encode unsigned varint (MC-style, 5-byte max for int32). */
export function encodeVarInt(value) {
    const bytes = [];
    let v = value >>> 0; // treat as uint32
    while ((v & ~0x7f) !== 0) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
}

/** Decode varint from a Buffer at offset. Returns { value, bytes }. */
export function decodeVarInt(buf, offset = 0) {
    let value = 0;
    let bytes = 0;
    let shift = 0;
    while (true) {
        if (offset + bytes >= buf.length) throw new Error('varint: out of bounds');
        const b = buf[offset + bytes];
        value |= (b & 0x7f) << shift;
        bytes++;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift >= 35) throw new Error('varint: too long');
    }
    return { value: value | 0, bytes }; // back to signed int32
}

/** MC string: varint(byteLen) + utf8 bytes. */
export function encodeString(s) {
    const utf8 = Buffer.from(s, 'utf8');
    return Buffer.concat([encodeVarInt(utf8.length), utf8]);
}

export function decodeString(buf, offset = 0) {
    const { value: len, bytes: lenBytes } = decodeVarInt(buf, offset);
    const start = offset + lenBytes;
    const s = buf.slice(start, start + len).toString('utf8');
    return { value: s, bytes: lenBytes + len };
}

/**
 * Map<Identifier(string), int> as owo encodes it: writeMap from FriendlyByteBuf
 * with key=Identifier (writeString of "ns:path") and value=Integer (writeVarInt).
 * Critically: owo's Integer serializer registers method_10804 (writeVarInt), NOT
 * writeInt — so values must be VarInt-encoded, not 4-byte big-endian.
 */
export function encodeMap(map) {
    const entries = Object.entries(map);
    const parts = [encodeVarInt(entries.length)];
    for (const [k, v] of entries) {
        parts.push(encodeString(k));
        parts.push(encodeVarInt(v));
    }
    return Buffer.concat(parts);
}

export function decodeMap(buf, offset = 0) {
    let cursor = offset;
    const head = decodeVarInt(buf, cursor); cursor += head.bytes;
    const out = {};
    for (let i = 0; i < head.value; i++) {
        const k = decodeString(buf, cursor); cursor += k.bytes;
        const v = decodeVarInt(buf, cursor); cursor += v.bytes;
        out[k.value] = v.value;
    }
    return { value: out, bytes: cursor - offset };
}

/** owo HandshakeResponse = three Map<Identifier,int32>. */
export function encodeOwoHandshakeResponse({ requiredChannels, requiredControllers, optionalChannels }) {
    return Buffer.concat([
        encodeMap(requiredChannels || {}),
        encodeMap(requiredControllers || {}),
        encodeMap(optionalChannels || {}),
    ]);
}

export function decodeOwoHandshakeRequest(buf) {
    // Server's request currently sends just optionalChannels (a single map).
    // Tolerate empty buffer.
    if (!buf || buf.length === 0) return { optionalChannels: {} };
    const m = decodeMap(buf, 0);
    return { optionalChannels: m.value };
}
