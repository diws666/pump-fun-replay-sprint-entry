// Early-entry, patient-exit scalper with a momentum entry filter for the pump.fun replay (v6).
//
// Coins drift up on average after their real reserve crosses 1 SOL, but the
// median coin crabs and flat sells only bleed fees. v6 enters each coin exactly
// once, as soon as the 1%-of-reserve order cap allows a >= 0.01 SOL buy and the
// coin's short tape shows net buying (several buyers, price up and near its
// window high, latest print a buy), then sells whole only on a real win: take
// profit at +80% or a trailing stop armed at +40%. Everything else is held:
// duds are recycled on a long time limit (60k slots) or flushed with the
// replay, and a drained curve simply rejects sells until the market refills it
// (rejected sells cost nothing). Small size (0.02 SOL), max 5 positions, so
// drawdown stays far under the 50% cap and fee churn stays bounded.
//
// Every decision is a pure function of the events seen so far: no clock, no
// randomness, no network, no file reads outside the repo.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000n;
const CURVE_FEE = 0.0125; // protocol 95 + creator fallback 30, share of spend

export interface Params {
  /** Slots in the entry tape window. */
  window: number;
  /** Trades the tape needs in the window before an entry. */
  minTrades: number;
  /** Distinct buying trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Net buy SOL (buys minus sells) over the window must exceed this. */
  minNetSol: number;
  /** Price gain from the window start required to enter. */
  minPriceUp: number;
  /** Price must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve at entry, SOL. The order cap is 1% of this reserve. */
  minRqSol: number;
  /** Buy size, SOL (at most the 1%-of-reserve cap). */
  buySol: number;
  /** Smallest buy we send; also the round-trip floor (0.01 SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Exits: sell whole on trailing stop (armed at +20%) or stop loss; time limit recycles duds. */
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 300,
  minTrades: 10,
  minBuys: 3,
  minBuyers: 2,
  minNetSol: 0,
  minPriceUp: 0.02,
  nearHigh: 0.80,
  minRqSol: 1.0,
  buySol: 0.02,
  minBuySol: 0.01,
  buySlipBps: 3000,
  takeProfit: 1.60,
  stopLoss: 0.50,
  trailArm: 0.20,
  trail: 0.10,
  maxHold: 60000,
  maxEntries: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  trades: Trade[];
}

interface Held {
  opened: number;
  peak: number;
  entries: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<string, Coin>();
  const held = new Map<string, Held>();
  const keep = p.window + 10;

  const coinOf = (mint: string): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, trades: [] };
      coins.set(mint, c);
    }
    return c;
  };

  const entrySignal = (c: Coin, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol) return false;
    if (c.trades.length < p.minTrades) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Set<string>();
    const latest = c.trades[c.trades.length - 1]!;
    if (!latest.buy) return false;
    for (const tr of c.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.add(tr.user);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp) return false;
    if (high <= 0 || last < high * p.nearHigh) return false;
    return true;
  };

  const trim = (c: Coin, now: number) => {
    let cut = 0;
    while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
    if (cut > 0) c.trades.splice(0, cut);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = Number(state.txFeeLamports()) / Number(LAMPORTS);
      const orders: OrderInput[] = [];
      const capOrders = state.hello.caps.max_orders_per_batch;
      const pendingByMint = new Set<string>();
      const pendingSell = new Set<string>();
      for (const po of state.pending.values()) {
        pendingByMint.add(po.order.mint);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

      // Drop coins we no longer have a position or open order in.
      for (const [mint, h] of held) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) held.delete(mint);
      }

      // Exits: take profit, trailing stop, time limit. Sell whole.
      for (const [mint, h] of held) {
        if (orders.length >= capOrders) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (pendingSell.has(mint)) continue;
        const mk = batch.marks.find((m) => m.mint === mint);
        const vq = Number((mk ?? curve).virtual_quote_reserves);
        const vt = Number((mk ?? curve).virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = (tokens * vq) / (vt + tokens) / Number(LAMPORTS);
        const cost = Number(pos.cost_lamports) / Number(LAMPORTS);
        const net = value * (1 - CURVE_FEE) - tx;
        if (net > h.peak) h.peak = net;
        let exit = false;
        if (net >= cost * p.takeProfit) exit = true;
        else if (h.peak >= cost * p.trailArm && net < h.peak * p.trail) exit = true;
        else if (net <= cost * p.stopLoss) exit = true;
        else if (now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Events: register curves and extend tapes.
      const traded = new Set<string>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / Number(LAMPORTS);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) trim(coinOf(mint), now);

      // Entries: one shot per coin, on momentum, as soon as the size cap allows.
      let free = Number(state.freeCashLamports()) / Number(LAMPORTS);
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= capOrders || slotsLeft <= 0 || free < p.buySol + tx) break;
        if (held.has(mint) || pendingByMint.has(mint)) continue;
        const c = coinOf(mint);
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        if (h !== undefined && h.entries >= p.maxEntries) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / Number(LAMPORTS);
        let amount = Math.min(p.buySol, capSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        if (!entrySignal(c, now, Number(curve.real_quote_reserves) / Number(LAMPORTS))) continue;
        const lamports = BigInt(Math.floor(amount * Number(LAMPORTS)));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft -= 1;
        held.set(mint, { opened: now, peak: 0, entries: (h === undefined ? 0 : h.entries) + 1 });
      }
      return orders;
    },
  };
}
