import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

// protodef's FullPacketParser does `console.log(e.stack)` on every
// PartialReadError. Modded servers emit oversize recipe/command packets that
// trigger this every spawn — 4+ multi-KB sync stderr writes that stall the
// event loop long enough for keep_alive ACKs to go out late, causing the
// server to stop sending keep_alive and ultimately kicking the bot at the
// checkTimeoutInterval. Suppress these stack dumps (the bridge layer already
// has structured logging for handshake issues; in-band decode failures here
// are non-fatal — protodef returns cb() with no error).
const _origLog = console.log.bind(console);
const _seenPartialReadErrors = new Set();
console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('PartialReadError:')) {
        const sig = args[0].split('\n')[0];
        if (_seenPartialReadErrors.size > 64) _seenPartialReadErrors.clear();
        if (!_seenPartialReadErrors.has(sig)) {
            _seenPartialReadErrors.add(sig);
            _origLog(`[suppressing repeated stack dumps] ${sig}`);
        }
        return;
    }
    _origLog(...args);
};

// Pathfinder rejects with PathStopped/GoalChanged when the bot is interrupted
// mid-path. action_manager catches the first reject, but pathfinder may emit a
// follow-up reject from the stop() teardown that nothing is awaiting, which
// node treats as fatal. Only swallow those two — NoPath/Timeout are caller-
// observable failures and `Timeout` is a name shared with many other libs.
process.on('unhandledRejection', (err) => {
    const name = err?.name || '';
    if (name === 'PathStopped' || name === 'GoalChanged') {
        console.warn(`[unhandledRejection swallowed] ${name}: ${err.message}`);
        return;
    }
    console.error('Unhandled promise rejection:', err);
});

// mineflayer's block_actions plugin throws synchronously on modded chests
// where `parseChestMetadata(block).facing` is undefined (the FACING_MAP
// lookup returns undefined → Object.values throws). Narrow guard: both the
// stack must point at block_actions AND the message must be the known
// signature, so real bugs in mineflayer's other plugins still surface.
process.on('uncaughtException', (err) => {
    const msg = err?.message || '';
    const stack = err?.stack || '';
    const isKnownPluginSig =
        stack.includes('mineflayer/lib/plugins/block_actions.js') &&
        msg.includes('Cannot convert undefined or null to object');
    if (isKnownPluginSig) {
        console.warn(`[uncaughtException swallowed] ${err.name}: ${msg}`);
        return;
    }
    console.error('Uncaught exception:', err);
    process.exit(1);
});

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
