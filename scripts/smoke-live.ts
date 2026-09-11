// Opt-in, read-only validation through the same stdio transport clients use.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const wallet = process.argv[2] ?? '0xff16003f5bc3560daf4b9df62c191831af47387f';
const outcomeId = Number(process.argv[3] ?? 1866);
const coin = `#${outcomeId * 10}`;
const client = new Client({ name: 'liquidiction-live-check', version: '1.0.0' });
const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../mcp-server.ts', import.meta.url))],
  env, stderr: 'inherit',
});

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const inputs: Record<string, Record<string, unknown>> = {
    get_user_positions: { address: wallet }, get_open_orders: { address: wallet },
    get_user_fills: { address: wallet, limit: 3 }, get_market_detail: { outcome_id: outcomeId },
    get_orderbook: { outcome_id: outcomeId }, get_candles: { coin, hours: 1 },
    get_recent_trades: { coin }, get_prices: {}, list_markets: {}, get_market_summary: {},
  };
  for (const [name, args] of Object.entries(inputs)) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    const text = (result.content as { type: string; text?: string }[]).filter(item => item.type === 'text').map(item => item.text).join('\n');
    assert.ok(text.length > 0);
    if (name === 'get_user_positions') {
      const data = JSON.parse(text);
      const response = await fetch(`${env.HL_API_URL ?? 'https://api.hyperliquid.xyz'}/info`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: wallet }), signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok);
      const raw = await response.json() as { balances: { coin: string; total: string }[] };
      const expected = raw.balances.filter(b => /^[#+]\d+[01]$/.test(b.coin) && Number(b.total) > 0);
      assert.ok(expected.length > 0, 'Choose a wallet that currently has nonzero outcome holdings.');
      for (const balance of expected) {
        const position = data.positions.find((p: { rawCoin: string }) => p.rawCoin === balance.coin);
        assert.ok(position, `Missing balance ${balance.coin}`);
        // A live wallet can trade between the two reads; rerun if this comparison races.
        assert.equal(position.shares, Number(balance.total), `Balance changed or incorrect for ${balance.coin}`);
      }
      console.log(JSON.stringify({ tool: name, fetchedAt: data.fetchedAt,
        positions: data.positions.filter((p: { outcomeId: number }) => [1866, 2389].includes(p.outcomeId)) }, null, 2));
    }
    console.log(`${name}: OK (${text.length} characters)`);
  }
} finally {
  await client.close();
}
