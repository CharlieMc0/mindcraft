// Lookup wrapper for mod registries (blocks + items) exposed by the bridge.
// Use when minecraft-data's vanilla registry can't resolve an id.

import { cachedFetch, clearCache as clearHttpCache } from './http_cache.js';

const HINT = 'Start it with: cd bridge && ./run.sh';

/**
 * @param {string} baseUrl modbridge URL, e.g. http://localhost:7474
 * @param {'blocks'|'items'} kind
 */
export function getRegistry(baseUrl, kind) {
    return cachedFetch(`${baseUrl.replace(/\/$/, '')}/registry/${kind}`, HINT);
}

/**
 * Resolve a numeric registry id to its `<modid>:<path>` name.
 * @returns {Promise<string|undefined>}
 */
export async function resolveModId(baseUrl, kind, rawId) {
    const reg = await getRegistry(baseUrl, kind);
    return reg[String(rawId)];
}

export function clearCache() {
    clearHttpCache();
}
