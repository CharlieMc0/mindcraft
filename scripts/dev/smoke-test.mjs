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
import { resolveModId } from '../../src/utils/modcompat/registry_client.js';
import { attachModCompat } from '../../src/utils/modcompat/handshake_router.js';

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
bot.loadPlugin(pathfinder);

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
