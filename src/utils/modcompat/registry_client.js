// Lookup wrapper for mod registries (blocks + items) exposed by the bridge.
// Use when minecraft-data's vanilla registry can't resolve an id — falls back
// to the modded "<modid>:<path>" name dumped from the live server JVM.

let cached = { blocks: null, items: null };
let inflight = { blocks: null, items: null };

async function fetchRegistry(baseUrl, key) {
    if (cached[key]) return cached[key];
    if (inflight[key]) return inflight[key];
    const url = `${baseUrl.replace(/\/$/, '')}/registry/${key}`;
    inflight[key] = (async () => {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${url} returned ${res.status}`);
            const json = await res.json();
            cached[key] = json;
            return json;
        } finally {
            inflight[key] = null;
        }
    })();
    return inflight[key];
}

/**
 * Resolve a numeric registry id to its `<modid>:<path>` name.
 * @param {string} baseUrl modbridge URL, e.g. http://localhost:7474
 * @param {'blocks'|'items'} kind
 * @param {number} rawId
 * @returns {Promise<string|undefined>}
 */
export async function resolveModId(baseUrl, kind, rawId) {
    const reg = await fetchRegistry(baseUrl, kind);
    return reg[String(rawId)];
}

/** Returns the full registry for one kind (cached). */
export async function getRegistry(baseUrl, kind) {
    return fetchRegistry(baseUrl, kind);
}

export function clearCache() {
    cached = { blocks: null, items: null };
    inflight = { blocks: null, items: null };
}
