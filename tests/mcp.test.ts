import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, API_URL } from '../mcp-server.js';
import { buildPositions, normalizeOutcomeCoin, requestOutcomeCoin, type OutcomeMeta } from '../outcomes.js';

const wallet = '0xff16003f5bc3560daf4b9df62c191831af47387f';
const metadata: OutcomeMeta = {
  outcomes: [
    { outcome: 1866, name: 'template:sportsContestWinner', venue: 'txyz',
      description: 'competition:NFL|participantA:Dallas Cowboys|participantB:New York Giants|scheduledStart:20260914-0020',
      sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }] },
    { outcome: 2389, name: 'template:sportsContestWinner', venue: 'out',
      description: 'competition:NFL|participantA:New York Giants|participantB:Dallas Cowboys|scheduledStart:20260914-0020',
      sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }] },
    { outcome: 2345, name: 'template:sportsContestParticipant2', venue: 'out', description: 'participant:Manchester United',
      sideSpecs: [{ name: 'Yes' }, { name: 'No' }] },
  ],
  questions: [{ question: 240, name: 'template:sportsContestResult',
    description: 'competition:EPL|participantA:Manchester United|participantB:Manchester City',
    fallbackOutcome: 2344, namedOutcomes: [2345] }],
  deployers: [{ venue: 'out', deployer: '0xout' }, { venue: 'txyz', deployer: '0xtxyz' }],
};
const balances = [
  { coin: '+18660', total: '84.0', hold: '49.0' },
  { coin: '+18661', total: '347.0', hold: '0.0' },
  { coin: '+23890', total: '74.0', hold: '0.0' },
  { coin: '+23891', total: '83.0', hold: '83.0' },
];
const mids = { '#18660': '0.6', '#18661': '0.4', '#23890': '0.4', '#23891': '0.6' };

async function connect(respond: (body: Record<string, unknown>) => unknown) {
  const server = createServer(async <T>(body: object) => respond(body as Record<string, unknown>) as T);
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function responseText(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text?: string }[];
  return content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

test('defaults to mainnet unless explicitly configured', () => {
  assert.equal(API_URL, process.env.HL_API_URL ?? 'https://api.hyperliquid.xyz');
});

test('request aliases normalize, but API spot @ identifiers are excluded', () => {
  for (const coin of ['#18660', '+18660', '@18660', '18660']) assert.equal(requestOutcomeCoin(coin), '#18660');
  for (const coin of ['@18660', '18660', 'HYPE', 'o18660', '#18662', '+NaN']) assert.equal(normalizeOutcomeCoin(coin), null);
  for (const coin of ['#-10', '#1.5', '#9007199254741000', '@@18660', '', '#18662']) {
    assert.throws(() => requestOutcomeCoin(coin));
  }
});

test('verified cross-deployer fixture retains each side, venue and held balance', () => {
  const result = buildPositions(balances, mids, metadata);
  assert.deepEqual(result.map(p => [p.coin, p.shares, p.selection, p.venue, p.heldShares, p.unheldShares]), [
    ['#18660', 84, 'Dallas Cowboys', 'txyz', 49, 35],
    ['#18661', 347, 'New York Giants', 'txyz', 0, 347],
    ['#23890', 74, 'New York Giants', 'out', 0, 74],
    ['#23891', 83, 'Dallas Cowboys', 'out', 83, 0],
  ]);
  assert.equal(result[0].markPrice, 0.6);
  assert.equal(result[0].rawCoin, '+18660');
  assert.equal(result[3].deployer, '0xout');
});

test('missing marks are null, fractional holdings survive, ordinary spot is excluded', () => {
  const result = buildPositions([
    { coin: '#23451', total: '0.125', hold: '0.025' },
    { coin: '+9990', total: '1' },
    { coin: 'HYPE', total: '100' },
    { coin: '@18660', total: '100' },
    { coin: '+18660', total: '0' },
    { coin: '+18661', total: 'NaN' },
  ], { '#23451': 'NaN' }, metadata);
  assert.equal(result.length, 2);
  assert.equal(result[0].shares, 0.125);
  assert.equal(result[0].selection, 'No · Manchester United');
  assert.equal(result[0].market, 'EPL: Manchester United v Manchester City');
  assert.equal(result[0].markPrice, null);
  assert.equal(result[0].markedValue, null);
  assert.equal(result[1].venue, null);
  assert.equal(result[1].unheldShares, null);
});

test('zero is a valid mark and an out-of-range mark is unavailable', () => {
  const result = buildPositions(balances, { '#18660': '0', '#18661': '2', '#23890': '' }, metadata);
  assert.equal(result[0].markedValue, 0);
  assert.equal(result[1].markPrice, null);
  assert.equal(result[2].markPrice, null);
});

test('positions tool works through MCP and exposes all four holdings', async () => {
  const session = await connect(body => {
    if (body.type === 'spotClearinghouseState') { assert.equal(body.user, wallet); return { balances }; }
    if (body.type === 'allMids') return mids;
    if (body.type === 'outcomeMeta') return metadata;
    throw new Error('Unexpected request');
  });
  try {
    assert.equal((await session.client.listTools()).tools.length, 10);
    const response = await session.client.callTool({ name: 'get_user_positions', arguments: { address: wallet } });
    assert.ok(!response.isError);
    const data = JSON.parse(responseText(response));
    assert.equal(data.positions.length, 4);
    assert.equal(data.positions[3].selection, 'Dallas Cowboys');
    assert.equal(data.address, wallet);
  } finally { await session.close(); }
});

test('candle and recent-trade requests use #N and return current-format trades', async () => {
  const session = await connect(body => {
    if (body.type === 'candleSnapshot') {
      assert.equal((body.req as { coin: string }).coin, '#18660');
      return [];
    }
    assert.equal(body.type, 'recentTrades');
    assert.equal(body.coin, '#18660');
    return [{ coin: '#18660', side: 'B', sz: '12', px: '0.6', time: 0 },
      { coin: '#23891', side: 'B', sz: '999', px: '0.6', time: 0 }];
  });
  try {
    for (const coin of ['#18660', '+18660', '@18660', '18660']) {
      const candles = await session.client.callTool({ name: 'get_candles', arguments: { coin } });
      assert.ok(!candles.isError);
      const trades = await session.client.callTool({ name: 'get_recent_trades', arguments: { coin } });
      assert.match(responseText(trades), /12 @ 60.0%/);
      assert.doesNotMatch(responseText(trades), /999/);
    }
  } finally { await session.close(); }
});

test('fills and orders include #/+ outcome rows and exclude @ spot rows', async () => {
  const session = await connect(() => ['#18660', '+23891', '@18660', 'HYPE'].map(coin => ({
    coin, side: 'B', px: '0.5', sz: '1', time: 0, closedPnl: '0', limitPx: '0.5', oid: 1,
  })));
  try {
    for (const name of ['get_user_fills', 'get_open_orders']) {
      const result = await session.client.callTool({ name, arguments: { address: wallet } });
      assert.ok(!result.isError);
      assert.match(responseText(result), /#18660/);
      assert.match(responseText(result), /\+23891/);
      assert.doesNotMatch(responseText(result), /@18660|HYPE/);
    }
  } finally { await session.close(); }
});

test('null books/history are handled and malformed inputs never call the API', async () => {
  let calls = 0;
  const session = await connect(() => { calls++; return null; });
  try {
    for (const [name, args] of [
      ['get_orderbook', { outcome_id: 1866 }], ['get_candles', { coin: '#18660' }],
      ['get_recent_trades', { coin: '#18660' }],
    ] as const) {
      assert.ok(!(await session.client.callTool({ name, arguments: args })).isError);
    }
    assert.equal(calls, 3);
    for (const [name, args] of [
      ['get_orderbook', { outcome_id: 1.5 }], ['get_orderbook', { outcome_id: 1, side: 0.5 }],
      ['get_candles', { coin: '#18662' }], ['get_user_positions', { address: 'invalid' }],
    ] as const) {
      assert.ok((await session.client.callTool({ name, arguments: args })).isError);
    }
    assert.equal(calls, 3);
  } finally { await session.close(); }
});

test('API failures surface as errors, not empty wallets', async () => {
  const session = await connect(() => { throw new Error('HL API error: 429'); });
  try {
    const result = await session.client.callTool({ name: 'get_user_positions', arguments: { address: wallet } });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /429/);
  } finally { await session.close(); }
});
