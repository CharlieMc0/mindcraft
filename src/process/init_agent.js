import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

// Pathfinder rejects with PathStopped/GoalChanged when the bot is interrupted
// mid-path. action_manager catches the first reject, but pathfinder may emit a
// follow-up reject from the stop() teardown that nothing is awaiting, which
// node treats as fatal. Swallow these specific noise rejections.
process.on('unhandledRejection', (err) => {
    const name = err?.name || '';
    if (name === 'PathStopped' || name === 'GoalChanged' || name === 'NoPath' || name === 'Timeout') {
        console.warn(`[unhandledRejection swallowed] ${name}: ${err.message}`);
        return;
    }
    console.error('Unhandled promise rejection:', err);
});

// Mineflayer plugins (block_actions, etc.) throw synchronously on modded
// blocks whose metadata shape doesn't match vanilla (e.g. chests where
// `parseChestMetadata(block).facing` is undefined → Object.values throws).
// Swallow plugin-side noise so the agent stays alive on heavily-modded servers.
process.on('uncaughtException', (err) => {
    const msg = err?.message || '';
    const stack = err?.stack || '';
    if (stack.includes('mineflayer/lib/plugins/') ||
        msg.includes('Cannot convert undefined or null to object') ||
        msg.includes('Cannot read properties of undefined')) {
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
