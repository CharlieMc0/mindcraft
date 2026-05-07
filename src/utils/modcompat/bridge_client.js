// Thin client for the local mindcraft-modbridge daemon.
// JS holds zero mod schemas; bridge owns all mod-protocol truth.

import { cachedFetch, clearCache as clearHttpCache } from './http_cache.js';

const HINT = 'Start it with: cd bridge && ./run.sh';

export function fetchOwoHashes(baseUrl) {
    return cachedFetch(`${baseUrl.replace(/\/$/, '')}/owo/hashes`, HINT);
}

export function clearCache() {
    clearHttpCache();
}
