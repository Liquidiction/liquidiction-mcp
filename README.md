<p align="center">
  <img src="https://testnet.liquidiction.xyz/logo.png" alt="Liquidiction" width="80" />
</p>

<h1 align="center">Liquidiction MCP Server</h1>

<p align="center">
  Query live Hyperliquid HIP-4 prediction market data from any MCP-compatible AI agent
</p>

<p align="center">
  <a href="https://testnet.liquidiction.xyz">App</a> |
  <a href="https://liquidiction.xyz">Website</a> |
  <a href="https://x.com/LiquidictionHL">Twitter</a>
</p>

<p align="center">
  <a href="https://glama.ai/mcp/servers/Liquidiction/liquidiction-mcp">
    <img src="https://glama.ai/mcp/servers/Liquidiction/liquidiction-mcp/badges/score.svg" alt="Liquidiction/liquidiction-mcp MCP server" />
  </a>
</p>

---

## What is this?

An MCP (Model Context Protocol) server that gives AI agents like Claude, GPT, and custom agents direct access to live HIP-4 prediction market data on Hyperliquid. This is the first MCP server for prediction markets.

No API keys required. Connects directly to Hyperliquid's public API.

## Tools (10)

| Tool | Description |
|------|-------------|
| `list_markets` | All active prediction markets with current prices |
| `get_market_detail` | Detailed info for a specific outcome ID |
| `get_market_summary` | Rich overview with probabilities, settlement status, and parsed metadata |
| `get_orderbook` | L2 order book (bids, asks, spread) for an outcome side |
| `get_prices` | Current mid-prices for all outcome coins |
| `get_candles` | OHLCV candle data for charting and analysis |
| `get_recent_trades` | Latest trades on a specific market |
| `get_user_fills` | Trade history for a wallet address |
| `get_open_orders` | Resting limit orders for a wallet |
| `get_user_positions` | Current outcome share holdings and values |

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "liquidiction": {
      "command": "npx",
      "args": ["tsx", "/path/to/liquidiction-mcp/mcp-server.ts"]
    }
  }
}
```

Restart Claude Desktop, then try:
- "What are the current HIP-4 prediction market odds?"
- "Show me the orderbook for outcome 13"
- "What positions does 0x1393...1869 hold?"

### Claude Code

```bash
claude mcp add liquidiction npx tsx /path/to/liquidiction-mcp/mcp-server.ts
```

### Run Standalone

```bash
git clone https://github.com/Liquidiction/liquidiction-mcp.git
cd liquidiction-mcp
npm install
npm start
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `HL_API_URL` | `https://api.hyperliquid-testnet.xyz` | Hyperliquid API endpoint |

Set to `https://api.hyperliquid.xyz` for mainnet data.

## Example Queries

### Market Odds
> "What are the odds on BTC above $71,566?"

Uses `get_market_summary` to fetch all markets, finds BTC markets, returns current probabilities.

### Orderbook Analysis
> "Is there good liquidity on the Hypurr vs Usain Bolt market?"

Uses `get_orderbook` to check bid/ask depth, spread, and order count.

### Portfolio Check
> "What are my positions and PnL?"

Uses `get_user_positions` + `get_user_fills` to show holdings and trade history.

### Price History
> "How has the HYPE prediction market moved in the last 24 hours?"

Uses `get_candles` with 1h interval to show price movement over time.

## What is HIP-4?

HIP-4 (Hyperliquid Improvement Proposal 4) introduces prediction markets that run natively on Hyperliquid's L1 order book engine. Key features:

- Binary outcomes (Yes/No) priced 0-100 cents
- Fully collateralized (no leverage, no liquidation risk)
- Shares the same infrastructure as perps and spot
- Supports recurring markets (15M, 1H, 1D periods)
- Settlement via on-chain oracle

## Premium API (x402)

For enriched data with orderbook depth, volume, and metadata:

```
GET https://testnet.liquidiction.xyz/api/premium/analytics
```

Paywalled at $0.001/request via x402 USDC micropayments on Base Sepolia.

## Links

- **App**: [testnet.liquidiction.xyz](https://testnet.liquidiction.xyz)
- **Landing**: [liquidiction.xyz](https://liquidiction.xyz)
- **Twitter**: [@LiquidictionHL](https://x.com/LiquidictionHL)
- **Telegram**: [t.me/Liquidiction](https://t.me/Liquidiction)
- **Built on**: [Hyperliquid](https://hyperliquid.xyz)

## License

MIT
