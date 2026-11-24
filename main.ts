// Pump.fun Replay Sprint entry.
//
// Deterministic paper bot for the agent-fun/replay/v2 bonding-curve replay:
// one small momentum-filtered buy per coin as soon as the 1%-of-reserve order
// cap allows it, then whole-position exits on take profit, trailing stop,
// stop loss or a long time limit. Pure function of the event stream: no
// clock, no randomness, no network, no reads outside this repo.
//
// The strategy itself lives in strategy.ts; runBot from the vendored SDK
// shim owns the wire (stdin/stdout, client_ids, order validation).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
