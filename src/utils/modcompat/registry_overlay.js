// Wires the bridge's runtime block + item registry into mindcraft's lookup
// surface (mc.getBlockId, mc.getBlockName, mc.getAllBlocks, item equivalents)
// so that callers — and the LLM via chat — can refer to modded blocks/items
// by their `<modid>:<path>` registry id.
//
// The overlay only KICKS IN when minecraft-data's vanilla table doesn't already
// have an entry, so vanilla behaviour is unchanged and existing code keeps
// working byte-for-byte.

import { getRegistry } from './registry_client.js';

let blocksById = null;       // numeric rawId → "modid:path"
let blocksByName = null;     // "modid:path" → numeric rawId
let itemsById = null;
let itemsByName = null;
let preloadStarted = false;

/**
 * Kick off the bridge fetches. Idempotent. Safe to call from initBot — does
 * not block; the overlay is simply empty until the fetches resolve, at which
 * point lookups for modded names start returning hits.
 */
export function preloadRegistries(modbridgeUrl) {
    if (preloadStarted) return;
    preloadStarted = true;
    if (!modbridgeUrl) return;

    getRegistry(modbridgeUrl, 'blocks').then((map) => {
        blocksById = map;
        blocksByName = invertMap(map);
        console.log(`[modcompat] registry overlay: ${Object.keys(blocksByName).length} modded blocks loaded`);
    }).catch((err) => console.warn(`[modcompat] block registry fetch failed: ${err.message}`));

    getRegistry(modbridgeUrl, 'items').then((map) => {
        itemsById = map;
        itemsByName = invertMap(map);
        console.log(`[modcompat] registry overlay: ${Object.keys(itemsByName).length} modded items loaded`);
    }).catch((err) => console.warn(`[modcompat] item registry fetch failed: ${err.message}`));
}

function invertMap(byId) {
    const out = {};
    for (const [rawId, name] of Object.entries(byId)) {
        out[name] = Number(rawId);
    }
    return out;
}

/** name like "farmersdelight:rice_panicle" → numeric rawId, or null. */
export function lookupBlockIdByName(name) {
    if (!blocksByName) return null;
    const id = blocksByName[name];
    return id === undefined ? null : id;
}

/** numeric rawId → "modid:path", or null. */
export function lookupBlockNameById(id) {
    if (!blocksById) return null;
    return blocksById[String(id)] ?? null;
}

export function lookupItemIdByName(name) {
    if (!itemsByName) return null;
    const id = itemsByName[name];
    return id === undefined ? null : id;
}

export function lookupItemNameById(id) {
    if (!itemsById) return null;
    return itemsById[String(id)] ?? null;
}

/** Synthetic block record mirroring minecraft-data's shape, just enough for
 *  callers iterating `getAllBlocks()`. Hardness/drops/tools left undefined. */
export function syntheticBlocks() {
    if (!blocksById) return [];
    const out = [];
    for (const [rawId, name] of Object.entries(blocksById)) {
        out.push({
            id: Number(rawId),
            name,
            displayName: name,
            stackSize: 64,
            diggable: true,
            // minecraft-data fields we don't know — leave undefined; callers
            // that depend on them will fall through their own undefined paths.
        });
    }
    return out;
}

export function syntheticItems() {
    if (!itemsById) return [];
    const out = [];
    for (const [rawId, name] of Object.entries(itemsById)) {
        out.push({
            id: Number(rawId),
            name,
            displayName: name,
            stackSize: 64,
        });
    }
    return out;
}

/** True once at least one registry has loaded (for diagnostics). */
export function isLoaded() {
    return blocksById !== null || itemsById !== null;
}
