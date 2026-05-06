// Smoke test: connect a bot to the local Homestead server, after spawn poke at
// the world to surface any breakage in the modded environment.
//
// Run via: node scripts/dev/smoke-test.mjs
// Requires:
//   - bridge daemon running on :7474
//   - local Homestead server running on :25567 (./scripts/dev/start-homestead-server.sh)
//
// Reports per-step PASS/FAIL. Exits 0 on all-pass, 1 otherwise.

import mineflayer from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
import collectBlockPlugin from 'mineflayer-collectblock';
import { resolveModId } from '../../src/utils/modcompat/registry_client.js';
import { attachModCompat } from '../../src/utils/modcompat/handshake_router.js';
import { preloadRegistries, lookupBlockIdByName, lookupBlockNameById } from '../../src/utils/modcompat/registry_overlay.js';

const { pathfinder, Movements, goals } = pkg;

const BRIDGE = 'http://localhost:7474';

const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25567,
    username: 'SmokeBot',
    auth: 'offline',
    version: '1.20.1',
    checkTimeoutInterval: 60000,
});
attachModCompat(bot, { modpack: 'homestead', modbridge_url: BRIDGE });
preloadRegistries(BRIDGE);
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlockPlugin.plugin);

// Suppress noisy PartialReadError on mod packets — mineflayer can't decode some
// modded payloads but they aren't critical for the smoke test.
bot._client.on('error', () => {});
bot.on('login', () => console.log('[smoke] login (JOIN_GAME)'));

const TIMEOUT = setTimeout(() => {
    record('overall_timeout', false, `no spawn after 120s (state=${bot._client.state})`);
    summarize();
    process.exit(1);
}, 120_000);

bot.once('spawn', async () => {
    clearTimeout(TIMEOUT);
    record('spawn', true);

    try {
        const pos = bot.entity.position;
        record('position', !!pos, `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`);

        const biomeId = bot.world.getBiome(pos);
        record('biome_id', typeof biomeId === 'number', `${biomeId}`);

        const blockUnder = bot.blockAt(pos.offset(0, -1, 0));
        record('block_under', !!blockUnder, blockUnder ? `${blockUnder.name} (id=${blockUnder.type})` : 'null');

        // Try to resolve a likely-modded item id via bridge (use 1003 — beautify:bookstack from earlier dump).
        const modName = await resolveModId(BRIDGE, 'blocks', 1003);
        record('bridge_lookup_block_1003', !!modName && modName.includes(':'), modName || 'undefined');

        // Wait briefly for the overlay to populate from the bridge fetches.
        await new Promise((r) => setTimeout(r, 1000));

        // mcdata-style lookups via the registry overlay (the same path mc.getBlockId
        // / getBlockName take). Validates that the LLM-side block resolution will
        // hit modded entries.
        const overlayId = lookupBlockIdByName('beautify:bookstack');
        record('overlay_block_name_to_id', overlayId === 1003, `beautify:bookstack -> ${overlayId}`);
        const overlayName = lookupBlockNameById(1003);
        record('overlay_block_id_to_name', overlayName === 'beautify:bookstack', `1003 -> ${overlayName}`);

        // Walk 3 blocks forward.
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        const target = pos.offset(3, 0, 0);
        try {
            await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
            const newPos = bot.entity.position;
            const moved = newPos.distanceTo(pos);
            record('walk_3_blocks', moved > 1, `moved=${moved.toFixed(2)}`);
        } catch (err) {
            record('walk_3_blocks', false, err.message);
        }

        // Send chat (tests bot.chat path).
        try {
            bot.chat('smoke-test ping');
            record('chat_send', true);
        } catch (err) {
            record('chat_send', false, err.message);
        }

        // Search nearby for vanilla wood (any *_log block) — proves bot's chunk
        // sensor picks up vanilla blocks in a modded world.
        const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
            'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']
            .map((n) => bot.registry.blocksByName[n]?.id).filter(Boolean);
        const log = bot.findBlock({ matching: logTypes, maxDistance: 64 });
        record('find_wood', !!log, log ? `${log.name} @ ${log.position.x},${log.position.y},${log.position.z}` : 'none within 64');

        // Try collecting it — exercises pathfinder + collectblock + dig path.
        if (log) {
            try {
                const before = bot.inventory.items().length;
                await Promise.race([
                    bot.collectBlock.collect(log),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('collect timeout')), 30_000)),
                ]);
                const after = bot.inventory.items().length;
                record('harvest_wood', after > before, `inv ${before}→${after}`);
            } catch (err) {
                record('harvest_wood', false, err.message);
            }
        } else {
            record('harvest_wood', false, 'skipped — no log found');
        }

        // Search for any nearby vanilla ore (or stone fallback) to confirm ore search works.
        const oreTypes = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore',
            'diamond_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore',
            'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_diamond_ore']
            .map((n) => bot.registry.blocksByName[n]?.id).filter(Boolean);
        const ore = bot.findBlock({ matching: oreTypes, maxDistance: 64 });
        record('find_ore', !!ore, ore ? `${ore.name} @ ${ore.position.x},${ore.position.y},${ore.position.z}` : 'none within 64');

        await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
        record('post_spawn_block', false, err.message);
    }

    summarize();
    bot.quit();
    process.exit(results.every(r => r.ok) ? 0 : 1);
});

bot.on('error', (err) => {
    record('error_event', false, err.message);
});

bot.on('kicked', (reason) => {
    record('kicked', false, reason);
    summarize();
    process.exit(1);
});

function summarize() {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n=== ${pass}/${results.length} passed ===`);
}
