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

const API_URL = process.env.HL_API_URL ?? 'https://api.hyperliquid-testnet.xyz';

// ---------------------------------------------------------------------------
// HL API helpers
// ---------------------------------------------------------------------------

async function hlInfo<T>(body: object): Promise<T> {
  const res = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API error: ${res.status}`);
  return res.json() as Promise<T>;
}

interface OutcomeRaw {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
}
interface QuestionRaw {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
}
interface OutcomeMeta { outcomes: OutcomeRaw[]; questions: QuestionRaw[] }
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

function outcomeToCoin(outcomeId: number, side: number): string {
  return `#${10 * outcomeId + side}`;
}

function coinToAtFormat(coin: string): string {
  const num = coin.startsWith('#') ? coin.slice(1) : coin;
  return `@${num}`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'liquidiction',
  version: '1.0.0',
});

// --- list_markets ---
server.tool(
  'list_markets',
  'List all prediction markets with current prices',
  {},
  async () => {
    const [meta, mids] = await Promise.all([
      hlInfo<OutcomeMeta>({ type: 'outcomeMeta' }),
      hlInfo<Record<string, string>>({ type: 'allMids' }),
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
          const mid = mids[coin] ? (parseFloat(mids[coin]) * 100).toFixed(1) + '%' : '?';
          return `${s.name}: ${mid}`;
        });
        const label = q ? `  [${o.outcome}] ${o.name}` : `\n[${o.outcome}] ${o.name}`;
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
  { outcome_id: z.number().describe('Outcome ID'), side: z.number().min(0).max(1).default(0).describe('Side (0=Yes/first, 1=No/second)') },
  async ({ outcome_id, side }) => {
    const coin = outcomeToCoin(outcome_id, side);
    const book = await hlInfo<L2Book>({ type: 'l2Book', coin });

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
    const mids = await hlInfo<Record<string, string>>({ type: 'allMids' });
    const outcomeMids = Object.entries(mids)
      .filter(([coin]) => coin.startsWith('#'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coin, px]) => `${coin}: ${(parseFloat(px) * 100).toFixed(2)}%`)
      .join('\n');

    return { content: [{ type: 'text', text: outcomeMids || 'No outcome prices found' }] };
  },
);

// --- get_user_fills ---
server.tool(
  'get_user_fills',
  'Get trade history for a user address',
  { address: z.string().describe('User wallet address'), limit: z.number().default(20).describe('Max number of fills to return') },
  async ({ address, limit }) => {
    const fills = await hlInfo<UserFill[]>({ type: 'userFills', user: address });
    const outcomeFills = fills.filter(f => f.coin.startsWith('#')).slice(0, limit);

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
  { address: z.string().describe('User wallet address') },
  async ({ address }) => {
    const orders = await hlInfo<OpenOrder[]>({ type: 'openOrders', user: address });
    const outcomeOrders = orders.filter(o => o.coin.startsWith('#'));

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
  'Get current outcome share positions for a user',
  { address: z.string().describe('User wallet address') },
  async ({ address }) => {
    const [spotState, mids] = await Promise.all([
      hlInfo<{ balances: { coin: string; total: string }[] }>({ type: 'spotClearinghouseState', user: address }),
      hlInfo<Record<string, string>>({ type: 'allMids' }),
    ]);

    const positions = spotState.balances
      .filter(b => b.coin.startsWith('#') && parseFloat(b.total) !== 0)
      .map(b => {
        const shares = parseFloat(b.total);
        const price = mids[b.coin] ? parseFloat(mids[b.coin]) : 0;
        const value = shares * price;
        return `${b.coin}: ${shares.toFixed(0)} shares @ ${(price * 100).toFixed(1)}% = $${value.toFixed(2)}`;
      });

    if (positions.length === 0) {
      return { content: [{ type: 'text', text: 'No outcome positions.' }] };
    }

    return { content: [{ type: 'text', text: positions.join('\n') }] };
  },
);

// --- get_market_detail ---
server.tool(
  'get_market_detail',
  'Get detailed info about a specific market outcome',
  { outcome_id: z.number().describe('Outcome ID') },
  async ({ outcome_id }) => {
    const [meta, mids] = await Promise.all([
      hlInfo<OutcomeMeta>({ type: 'outcomeMeta' }),
      hlInfo<Record<string, string>>({ type: 'allMids' }),
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
    lines.push(`Sides:`);
    for (let i = 0; i < outcome.sideSpecs.length; i++) {
      const coin = outcomeToCoin(outcome_id, i);
      const mid = mids[coin] ? (parseFloat(mids[coin]) * 100).toFixed(2) + '%' : 'N/A';
      lines.push(`  ${outcome.sideSpecs[i].name}: ${mid} (${coin})`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// --- get_candles ---
server.tool(
  'get_candles',
  'Get OHLCV candle data for a prediction market outcome',
  {
    coin: z.string().describe('Coin identifier, e.g. "#90"'),
    interval: z.string().default('1h').describe('Candle interval: "1m", "5m", "15m", "1h", "4h", "1d"'),
    hours: z.number().default(24).describe('Hours of history to fetch'),
  },
  async ({ coin, interval, hours }) => {
    const endTime = Date.now();
    const startTime = endTime - hours * 60 * 60 * 1000;

    const candles = await hlInfo<Candle[]>({
      type: 'candleSnapshot',
      req: { coin: coinToAtFormat(coin), interval, startTime, endTime },
    });

    const lines = candles.map(c => {
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
  { coin: z.string().describe('Coin identifier, e.g. "#90"') },
  async ({ coin }) => {
    const trades = await hlInfo<RecentTrade[]>({
      type: 'recentTrades',
      coin: coinToAtFormat(coin),
    });

    const outcomeTrades = trades.filter(t => t.coin.startsWith('@'));

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
      hlInfo<OutcomeMeta>({ type: 'outcomeMeta' }),
      hlInfo<Record<string, string>>({ type: 'allMids' }),
    ]);

    const questionMap = new Map<number, QuestionRaw>();
    for (const q of meta.questions) questionMap.set(q.question, q);

    const summary = meta.outcomes.map(o => {
      const question = [...questionMap.values()].find(q => q.namedOutcomes.includes(o.outcome));
      const sides = o.sideSpecs.map((s, i) => {
        const coin = outcomeToCoin(o.outcome, i);
        const mid = mids[coin];
        return {
          label: s.name,
          coin,
          probability: mid ? `${(parseFloat(mid) * 100).toFixed(1)}%` : null,
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

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
