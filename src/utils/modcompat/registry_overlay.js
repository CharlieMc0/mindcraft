// Overlays the bridge's runtime block + item registry on top of minecraft-data
// so mc.getBlockId / getBlockName / getAllBlocks (and item equivalents) can
// resolve "<modid>:<path>" names. Vanilla path is unchanged — overlay only
// fires when minecraft-data misses.

import { getRegistry } from './registry_client.js';

const reg = {
    blocks: { byId: null, byName: null, synthetic: [] },
    items:  { byId: null, byName: null, synthetic: [] },
};
let preloadStarted = false;

export function preloadRegistries(modbridgeUrl) {
    if (preloadStarted) return;
    preloadStarted = true;
    if (!modbridgeUrl) return;
    loadKind(modbridgeUrl, 'blocks');
    loadKind(modbridgeUrl, 'items');
}

function loadKind(modbridgeUrl, kind) {
    getRegistry(modbridgeUrl, kind).then((byId) => {
        const byName = Object.fromEntries(Object.entries(byId).map(([id, name]) => [name, Number(id)]));
        reg[kind].byId = byId;
        reg[kind].byName = byName;
        // Build the synthetic record array once. getAllBlocks() / getAllItems()
        // are hit on every planner tick; rebuilding 20K+ objects per call was
        // a measurable hot path in the LLM planning loop.
        reg[kind].synthetic = Object.entries(byId).map(([id, name]) => ({
            id: Number(id),
            name,
            displayName: name,
            stackSize: 64,
            diggable: kind === 'blocks',
            drops: [],
        }));
        console.log(`[modcompat] registry overlay: ${Object.keys(byName).length} modded ${kind} loaded`);
    }).catch((err) => console.warn(`[modcompat] ${kind} registry fetch failed: ${err.message}`));
}

export function lookupBlockIdByName(name) { return reg.blocks.byName?.[name] ?? null; }
export function lookupBlockNameById(id)   { return reg.blocks.byId?.[String(id)] ?? null; }
export function lookupItemIdByName(name)  { return reg.items.byName?.[name] ?? null; }
export function lookupItemNameById(id)    { return reg.items.byId?.[String(id)] ?? null; }
export function syntheticBlocks() { return reg.blocks.synthetic; }
export function syntheticItems()  { return reg.items.synthetic; }
export function isLoaded() { return reg.blocks.byId !== null || reg.items.byId !== null; }
