// Promise-cached fetch wrapper. Resolves a URL once; concurrent callers share
// the in-flight promise so the same URL never gets two simultaneous GETs.

const cached = new Map();   // url → resolved JSON
const inflight = new Map(); // url → in-flight Promise

/**
 * @param {string} url full URL to GET
 * @param {string} [unreachableHint] optional message appended when fetch throws
 *   (e.g. how to start the daemon serving this URL).
 */
export async function cachedFetch(url, unreachableHint = '') {
    if (cached.has(url)) return cached.get(url);
    if (inflight.has(url)) return inflight.get(url);

    const p = (async () => {
        let res;
        try {
            res = await fetch(url);
        } catch (err) {
            const tail = unreachableHint ? `\n${unreachableHint}` : '';
            throw new Error(`[modbridge] unreachable at ${url}: ${err.message}${tail}`);
        }
        if (!res.ok) throw new Error(`[modbridge] ${url} returned ${res.status}`);
        const json = await res.json();
        cached.set(url, json);
        return json;
    })();
    inflight.set(url, p);
    try {
        return await p;
    } finally {
        inflight.delete(url);
    }
}

export function clearCache() {
    cached.clear();
    inflight.clear();
}
