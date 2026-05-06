// Thin client for the local mindcraft-modbridge daemon.
// JS holds zero mod schemas; bridge owns all mod-protocol truth.

let cached = null;     // { url, hashes } once resolved
let inflight = null;   // { url, promise } during the first call (dedupe concurrent prewarm + responder)

export async function fetchOwoHashes(baseUrl) {
    const url = `${baseUrl.replace(/\/$/, '')}/owo/hashes`;
    if (cached && cached.url === url) return cached.hashes;
    if (inflight && inflight.url === url) return inflight.promise;

    inflight = { url, promise: doFetch(url) };
    try {
        const hashes = await inflight.promise;
        cached = { url, hashes };
        return hashes;
    } finally {
        inflight = null;
    }
}

async function doFetch(url) {
    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(
            `[modbridge] unreachable at ${url}: ${err.message}\n` +
            `Start it with: cd bridge && ./run.sh`);
    }
    if (!res.ok) throw new Error(`[modbridge] ${url} returned ${res.status}`);
    return res.json();
}

export function clearCache() {
    cached = null;
    inflight = null;
}
