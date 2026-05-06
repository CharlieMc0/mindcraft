// Thin client for the local mindcraft-modbridge daemon.
// JS holds zero mod schemas; bridge owns all mod-protocol truth.

let cachedHashes = null;
let cachedHashesUrl = null;

export async function fetchOwoHashes(baseUrl) {
    if (cachedHashes && cachedHashesUrl === baseUrl) return cachedHashes;
    const url = `${baseUrl.replace(/\/$/, '')}/owo/hashes`;
    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(
            `[modbridge] unreachable at ${baseUrl}: ${err.message}\n` +
            `Start it with: cd bridge && ./run.sh`);
    }
    if (!res.ok) throw new Error(`[modbridge] ${url} returned ${res.status}`);
    const json = await res.json();
    cachedHashes = json;
    cachedHashesUrl = baseUrl;
    return json;
}

export function clearCache() {
    cachedHashes = null;
    cachedHashesUrl = null;
}
