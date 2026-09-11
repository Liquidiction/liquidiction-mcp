#!/usr/bin/env npx tsx
/**
 * Liquidiction MCP Server
 *
 * Exposes Hyperliquid prediction market data as MCP tools.
 * Run: npx tsx mcp-server.ts
 * Config for Claude Desktop:
 *   { "command": "npx", "args": ["tsx", "<path>/mcp-server.ts"] }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import {
  buildPositions, marketContext, markPrice, normalizeOutcomeCoin, outcomeToCoin, requestOutcomeCoin,
  type Balance, type OutcomeMeta, type OutcomeRaw, type QuestionRaw,
} from './outcomes.js';

export const API_URL = process.env.HL_API_URL ?? 'https://api.hyperliquid.xyz';

// ---------------------------------------------------------------------------
// HL API helpers
// ---------------------------------------------------------------------------

async function hlInfo<T>(body: object): Promise<T> {
  const res = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HL API error: ${res.status}`);
  return res.json() as Promise<T>;
}

interface L2Level { px: string; sz: string; n: number }
interface L2Book { coin: string; levels: [L2Level[], L2Level[]] }
interface UserFill {
  coin: string; px: string; sz: string; side: string;
  time: number; closedPnl: string; fee: string;
}
interface OpenOrder {
  coin: string; limitPx: string; oid: number;
  side: string; sz: string; timestamp: number;
}
interface Candle {
  t: number; o: string; h: string; l: string; c: string; v: string; n: number;
}
interface RecentTrade {
  coin: string; side: string; px: string; sz: string; time: number; hash: string; tid: number;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a wallet address');
const outcomeIdSchema = z.number().int().nonnegative().max(Math.floor((Number.MAX_SAFE_INTEGER - 1) / 10));
const coinSchema = z.string().refine(coin => normalizeOutcomeCoin(coin, true) !== null, 'Invalid outcome coin');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(info: typeof hlInfo = hlInfo) {
const server = new McpServer({
  name: 'liquidiction',
  version: '1.0.1',
});

// --- list_markets ---
server.tool(
  'list_markets',
  'List all prediction markets with current prices',
  {},
  async () => {
    const [meta, mids] = await Promise.all([
      info<OutcomeMeta>({ type: 'outcomeMeta' }),
      info<Record<string, string>>({ type: 'allMids' }),
    ]);

    const questionMap = new Map<number, QuestionRaw>();
    for (const q of meta.questions) {
      questionMap.set(q.question, q);
    }

    const lines: string[] = [];
    // Group outcomes by question
    const grouped = new Map<number | null, OutcomeRaw[]>();
    for (const o of meta.outcomes) {
      const qId = [...questionMap.entries()].find(([, q]) =>
        q.namedOutcomes.includes(o.outcome)
      )?.[0] ?? null;
      if (!grouped.has(qId)) grouped.set(qId, []);
      grouped.get(qId)!.push(o);
    }

    for (const [qId, outcomes] of grouped) {
      const q = qId !== null ? questionMap.get(qId) : null;
      if (q) lines.push(`\n## ${q.name}`);

      for (const o of outcomes) {
        const sides = o.sideSpecs.map((s, i) => {
          const coin = outcomeToCoin(o.outcome, i);
          const price = markPrice(mids, coin);
          const mid = price === null ? '?' : `${(price * 100).toFixed(1)}%`;
          return `${marketContext(meta, o.outcome, i).selection ?? s.name}: ${mid}`;
        });
        const label = `[${o.outcome}] ${marketContext(meta, o.outcome, 0).market} (${o.venue ?? 'unknown venue'})`;
        lines.push(`${label} — ${sides.join(' | ')}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_orderbook ---
server.tool(
  'get_orderbook',
  'Get order book for a specific outcome side',
  { outcome_id: outcomeIdSchema.describe('Outcome ID'), side: z.number().int().min(0).max(1).default(0).describe('Side (0=Yes/first, 1=No/second)') },
  async ({ outcome_id, side }) => {
    const coin = outcomeToCoin(outcome_id, side);
    const book = await info<L2Book | null>({ type: 'l2Book', coin });
    if (!book) return { content: [{ type: 'text', text: `No order book available for ${coin}.` }] };

    const bids = book.levels[0].slice(0, 10);
    const asks = book.levels[1].slice(0, 10);

    const lines = [`Order book for ${coin}:`];
    lines.push('\nAsks (sell):');
    for (const a of asks.reverse()) {
      lines.push(`  ${a.px}  ${a.sz} (${a.n} orders)`);
    }
    lines.push('\nBids (buy):');
    for (const b of bids) {
      lines.push(`  ${b.px}  ${b.sz} (${b.n} orders)`);
    }

    const spread = asks.length > 0 && bids.length > 0
      ? (parseFloat(asks[asks.length - 1].px) - parseFloat(bids[0].px)).toFixed(4)
      : 'N/A';
    lines.push(`\nSpread: ${spread}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_prices ---
server.tool(
  'get_prices',
  'Get current mid prices for all outcome coins',
  {},
  async () => {
    const mids = await info<Record<string, string>>({ type: 'allMids' });
    const coins = [...new Set(Object.keys(mids).map(coin => normalizeOutcomeCoin(coin)).filter((coin): coin is string => coin !== null))];
    const outcomeMids = coins
      .sort()
      .map(coin => {
        const price = markPrice(mids, coin);
        return `${coin}: ${price === null ? 'unavailable' : `${(price * 100).toFixed(2)}%`}`;
      })
      .join('\n');

    return { content: [{ type: 'text', text: outcomeMids || 'No outcome prices found' }] };
  },
);

// --- get_user_fills ---
server.tool(
  'get_user_fills',
  'Get trade history for a user address',
  { address: addressSchema.describe('User wallet address'), limit: z.number().int().min(1).max(2000).default(20).describe('Max number of fills to return') },
  async ({ address, limit }) => {
    const fills = await info<UserFill[]>({ type: 'userFills', user: address });
    const outcomeFills = fills.filter(f => normalizeOutcomeCoin(f.coin) !== null).slice(0, limit);

    if (outcomeFills.length === 0) {
      return { content: [{ type: 'text', text: 'No outcome trades found for this address.' }] };
    }

    const lines = outcomeFills.map(f => {
      const date = new Date(f.time).toISOString().slice(0, 19);
      const pnl = parseFloat(f.closedPnl);
      const pnlStr = pnl !== 0 ? ` PnL: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
      return `${date} ${f.side.toUpperCase()} ${f.coin} ${f.sz} @ ${(parseFloat(f.px) * 100).toFixed(1)}%${pnlStr}`;
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_open_orders ---
server.tool(
  'get_open_orders',
  'Get open orders for a user address',
  { address: addressSchema.describe('User wallet address') },
  async ({ address }) => {
    const orders = await info<OpenOrder[]>({ type: 'openOrders', user: address });
    const outcomeOrders = orders.filter(o => normalizeOutcomeCoin(o.coin) !== null);

    if (outcomeOrders.length === 0) {
      return { content: [{ type: 'text', text: 'No open outcome orders.' }] };
    }

    const lines = outcomeOrders.map(o => {
      return `${o.side.toUpperCase()} ${o.coin} ${o.sz} @ ${(parseFloat(o.limitPx) * 100).toFixed(1)}% (oid: ${o.oid})`;
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_user_positions ---
server.tool(
  'get_user_positions',
  'Get current outcome balances with venue, participant, held shares and mark values. Does not discover wallets or merge contracts across deployers.',
  { address: addressSchema.describe('User wallet address') },
  async ({ address }) => {
    const [spotState, mids, meta] = await Promise.all([
      info<{ balances: Balance[] }>({ type: 'spotClearinghouseState', user: address }),
      info<Record<string, string>>({ type: 'allMids' }),
      info<OutcomeMeta>({ type: 'outcomeMeta' }),
    ]);

    const result = {
      address, fetchedAt: new Date().toISOString(),
      source: 'Hyperliquid public info API',
      note: 'Snapshot reads are not atomic. Unheld shares are total minus hold, not an execution guarantee. Markets on different venues retain their own settlement rules. Missing marks or metadata remain null.',
      positions: buildPositions(spotState.balances, mids, meta),
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- get_market_detail ---
server.tool(
  'get_market_detail',
  'Get detailed info about a specific market outcome',
  { outcome_id: outcomeIdSchema.describe('Outcome ID') },
  async ({ outcome_id }) => {
    const [meta, mids] = await Promise.all([
      info<OutcomeMeta>({ type: 'outcomeMeta' }),
      info<Record<string, string>>({ type: 'allMids' }),
    ]);

    const outcome = meta.outcomes.find(o => o.outcome === outcome_id);
    if (!outcome) {
      return { content: [{ type: 'text', text: `Outcome ${outcome_id} not found.` }] };
    }

    const question = meta.questions.find(q => q.namedOutcomes.includes(outcome_id));

    const lines: string[] = [];
    if (question) lines.push(`Question: ${question.name}`);
    lines.push(`Outcome: ${outcome.name}`);
    lines.push(`Description: ${outcome.description}`);
    lines.push(`Venue: ${outcome.venue ?? 'unknown'}`);
    lines.push(`Sides:`);
    for (let i = 0; i < outcome.sideSpecs.length; i++) {
      const coin = outcomeToCoin(outcome_id, i);
      const price = markPrice(mids, coin);
      const mid = price === null ? 'N/A' : `${(price * 100).toFixed(2)}%`;
      lines.push(`  ${marketContext(meta, outcome_id, i).selection ?? outcome.sideSpecs[i].name}: ${mid} (${coin})`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_candles ---
server.tool(
  'get_candles',
  'Get OHLCV candle data for a prediction market outcome',
  {
    coin: coinSchema.describe('Outcome coin: #N, +N, legacy @N, or numeric'),
    interval: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h'),
    hours: z.number().positive().max(8760).default(24).describe('Hours of history to fetch'),
  },
  async ({ coin, interval, hours }) => {
    const endTime = Date.now();
    const startTime = endTime - hours * 60 * 60 * 1000;

    const candles = await info<Candle[] | null>({
      type: 'candleSnapshot',
      req: { coin: requestOutcomeCoin(coin), interval, startTime, endTime },
    });

    const lines = (candles ?? []).map(c => {
      const time = new Date(c.t).toISOString().slice(0, 16);
      return `${time}  O:${(parseFloat(c.o) * 100).toFixed(1)}% H:${(parseFloat(c.h) * 100).toFixed(1)}% L:${(parseFloat(c.l) * 100).toFixed(1)}% C:${(parseFloat(c.c) * 100).toFixed(1)}% V:${c.v} (${c.n} trades)`;
    });

    return { content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No candle data found.' }] };
  },
);

// --- get_recent_trades ---
server.tool(
  'get_recent_trades',
  'Get recent trades for a prediction market outcome',
  { coin: coinSchema.describe('Outcome coin: #N, +N, legacy @N, or numeric') },
  async ({ coin }) => {
    const trades = await info<RecentTrade[] | null>({
      type: 'recentTrades',
      coin: requestOutcomeCoin(coin),
    });

    const outcomeTrades = (trades ?? []).filter(t => normalizeOutcomeCoin(t.coin) === requestOutcomeCoin(coin));

    if (outcomeTrades.length === 0) {
      return { content: [{ type: 'text', text: 'No recent trades found.' }] };
    }

    const lines = outcomeTrades.slice(0, 50).map(t => {
      const time = new Date(t.time).toISOString().slice(0, 19);
      return `${time} ${t.side.toUpperCase()} ${t.sz} @ ${(parseFloat(t.px) * 100).toFixed(1)}%`;
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_market_summary ---
server.tool(
  'get_market_summary',
  'Get a rich overview of all markets with probabilities, settlement status, and parsed metadata',
  {},
  async () => {
    const [meta, mids] = await Promise.all([
      info<OutcomeMeta>({ type: 'outcomeMeta' }),
      info<Record<string, string>>({ type: 'allMids' }),
    ]);

    const questionMap = new Map<number, QuestionRaw>();
    for (const q of meta.questions) questionMap.set(q.question, q);

    const summary = meta.outcomes.map(o => {
      const question = [...questionMap.values()].find(q => q.namedOutcomes.includes(o.outcome));
      const sides = o.sideSpecs.map((s, i) => {
        const coin = outcomeToCoin(o.outcome, i);
        const mid = markPrice(mids, coin);
        return {
          label: marketContext(meta, o.outcome, i).selection ?? s.name,
          coin,
          probability: mid === null ? null : `${(mid * 100).toFixed(1)}%`,
        };
      });

      // Parse key fields from description
      const desc = o.description;
      const expiry = desc.match(/expiry:([^\s|]+)/)?.[1] ?? null;
      const underlying = desc.match(/underlying:([^\s|]+)/)?.[1] ?? null;
      const targetPrice = desc.match(/targetPrice:([^\s|]+)/)?.[1] ?? null;
      const period = desc.match(/period:([^\s|]+)/)?.[1] ?? null;

      const isSettled = question
        ? question.settledNamedOutcomes?.includes(o.outcome) ?? false
        : false;

      return {
        id: o.outcome,
        venue: o.venue ?? null,
        market: marketContext(meta, o.outcome, 0).market,
        name: o.name,
        question: question?.name ?? null,
        sides,
        isSettled,
        expiry,
        underlying,
        targetPrice,
        period,
      };
    });

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  },
);

return server;
}

// Importing the factory for offline tests must not start a stdio server.
async function main() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
