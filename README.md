# Liquidiction MCP Server

Read-only HIP-4 prediction-market tools for MCP-compatible agents. The server connects directly to Hyperliquid's public API. No API keys, wallet connection or signing permissions are required.

## Install

Requires Node.js 20 or newer and npm.

```bash
git clone https://github.com/Liquidiction/liquidiction-mcp.git
cd liquidiction-mcp
npm ci
npm start
```

This is a stdio MCP server, so `npm start` waits for an MCP client rather than opening a website. Mainnet is the default. Set `HL_API_URL=https://api.hyperliquid-testnet.xyz` only when you want testnet data.

Existing installations: run `git pull --ff-only`, `npm ci`, then restart your MCP client.

## Connect a client

After installing dependencies, configure your client with absolute paths:

```json
{
  "mcpServers": {
    "liquidiction": {
      "command": "node",
      "args": [
        "/absolute/path/liquidiction-mcp/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/liquidiction-mcp/mcp-server.ts"
      ],
      "env": {
        "HL_API_URL": "https://api.hyperliquid.xyz"
      }
    }
  }
}
```

This uses the installed runtime and works even when the client's working directory is elsewhere. On Windows, use paths such as `C:/Users/you/liquidiction-mcp/mcp-server.ts` and the corresponding `node_modules/tsx/dist/cli.mjs` path. Restart the client after changing its configuration.

For Claude Code:

```bash
claude mcp add liquidiction -- node /absolute/path/liquidiction-mcp/node_modules/tsx/dist/cli.mjs /absolute/path/liquidiction-mcp/mcp-server.ts
```

For clients that launch from the repository directory, `npx tsx mcp-server.ts` also works.

## Tools

| Tool | Input | Result |
|---|---|---|
| `list_markets` | None | Active outcomes, selections, venues and prices |
| `get_market_detail` | `outcome_id` | Metadata, venue, selections and side prices |
| `get_market_summary` | None | Market overview and available settlement metadata |
| `get_orderbook` | `outcome_id`, optional `side` | Top bids, asks and spread |
| `get_prices` | None | Current outcome mid-prices |
| `get_candles` | `coin`, optional `interval`, optional `hours` | OHLCV history |
| `get_recent_trades` | `coin` | Recent public trades for the selected outcome side |
| `get_user_fills` | `address`, optional `limit` | Recent public HIP-4 fills for a wallet |
| `get_open_orders` | `address` | Public resting HIP-4 orders |
| `get_user_positions` | `address` | Positions, venues, selections, held shares and mark values |

Outcome API requests use `#N`. Explicit coin inputs also accept `+N`, legacy `@N` and bare numeric aliases and normalize them to `#N`. Wallet balances returned as `+N` retain their raw coin and also expose the canonical `#N` identifier. Ordinary spot `@N` rows are not classified as outcome holdings or fills.

## Cross-deployer positions

Ask your agent:

> Show the HIP-4 positions for this wallet, including venue, team, total shares and held shares. Compare positions on the same fixture without merging their contracts.

`get_user_positions` returns JSON text with `address`, `fetchedAt`, `source`, a snapshot note and a `positions` array. Each row includes:

- `coin`, `rawCoin`, `outcomeId`, `side`, `venue` and deployer address.
- Market and selection labels resolved from the contract metadata when available.
- `shares`, the original `total` string, `heldShares` and `unheldShares`.
- `markPrice` and `markedValue`, or `null` when a valid mark is unavailable.
- Available contract timing, result source and counted-play fields, plus raw descriptions.

Do not assume side 0 means the same team across venues. Outcome and trade.xyz can list a fixture in opposite participant order. The tools preserve distinct contracts and their rules; they do not certify equivalence or automatically merge positions.

`unheldShares` is total minus held shares, not a guarantee that an order can execute. Reads are not an atomic snapshot. Marks are estimates, not executable sale quotes. Missing active-market metadata remains `null`; this server does not supply historical metadata for every settled contract.

Supply a known wallet address. This server does not search an index for wallets holding a particular combination of markets.

## Development and verification

```bash
npm ci
npm run typecheck
npm test
```

The regression suite runs offline and covers current balance formats, cross-deployer side reversal, held shares, fractional balances, missing marks, input validation and API errors.

An optional read-only smoke check launches a real MCP stdio client and calls all 10 tools against the configured Hyperliquid network:

```bash
npm run test:live -- 0xff16003f5bc3560daf4b9df62c191831af47387f 1866
```

The example is a live wallet, so holdings can change. If it no longer has positions, choose another wallet and active outcome ID. The check compares MCP holdings against a separate balance read and can fail if the wallet trades between reads. Normal Hyperliquid rate limits apply.

## Links

- [Liquidiction](https://liquidiction.xyz)
- [MCP documentation](https://liquidiction.gitbook.io/liquidiction-docs/developers/mcp-server)
- [X](https://x.com/LiquidictionHL)

MIT licensed. This server never submits trades.
