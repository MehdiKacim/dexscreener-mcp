#!/usr/bin/env node
/**
 * DexScreener MCP Server
 * Real-time DEX data — BSC alpha scanner
 * Public API, no key needed
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest, ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = 'https://api.dexscreener.com';

async function dexGet(path: string) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`DexScreener error ${r.status}: ${r.statusText}`);
  return r.json();
}

const TOOLS = [
  {
    name: 'dx_token',
    description: 'Get real-time price, volume, liquidity and price change for a token by contract address. Works on BSC, ETH, SOL etc.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Token contract address, e.g. 0x997a58129890bbda032231a52ed1ddc845fc18e1' },
        chain: { type: 'string', description: 'Chain: bsc, ethereum, solana, etc. (optional, auto-detected)' }
      },
      required: ['address']
    }
  },
  {
    name: 'dx_search',
    description: 'Search tokens by name or symbol. Returns price, volume, liquidity, price change. Great for finding alpha.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token name or symbol, e.g. SIREN, PEPE, SHIB' }
      },
      required: ['query']
    }
  },
  {
    name: 'dx_trending_bsc',
    description: 'Get trending/hot tokens on BSC right now sorted by volume. Find pumping tokens before they explode.',
    inputSchema: {
      type: 'object',
      properties: {
        min_liquidity: { type: 'number', description: 'Minimum liquidity in USD (default: 10000)' },
        min_volume_h1: { type: 'number', description: 'Minimum 1h volume in USD (default: 5000)' }
      }
    }
  },
  {
    name: 'dx_new_pairs_bsc',
    description: 'Get newest token pairs created on BSC in the last few hours. Find early launches.',
    inputSchema: {
      type: 'object',
      properties: {
        min_liquidity: { type: 'number', description: 'Minimum liquidity in USD (default: 5000)' }
      }
    }
  },
  {
    name: 'dx_pair',
    description: 'Get detailed info for a specific trading pair by pair address.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain: bsc, ethereum, solana, etc.' },
        pair_address: { type: 'string', description: 'Pair contract address' }
      },
      required: ['chain', 'pair_address']
    }
  }
];

function formatPair(p: any) {
  return {
    name: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
    chain: p.chainId,
    dex: p.dexId,
    price_usd: p.priceUsd,
    price_change: {
      m5: p.priceChange?.m5,
      h1: p.priceChange?.h1,
      h6: p.priceChange?.h6,
      h24: p.priceChange?.h24,
    },
    volume: {
      m5: p.volume?.m5,
      h1: p.volume?.h1,
      h24: p.volume?.h24,
    },
    liquidity_usd: p.liquidity?.usd,
    market_cap: p.marketCap,
    fdv: p.fdv,
    txns_h1: { buys: p.txns?.h1?.buys, sells: p.txns?.h1?.sells },
    pair_address: p.pairAddress,
    pair_url: p.url,
    created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    base_token: {
      address: p.baseToken?.address,
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
    }
  };
}

async function handleTool(name: string, args: any): Promise<string> {
  switch (name) {

    case 'dx_token': {
      const data = await dexGet(`/latest/dex/tokens/${args.address}`);
      const pairs = data.pairs || [];
      if (!pairs.length) return JSON.stringify({ error: 'Token not found' });
      // Sort by volume
      pairs.sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
      const top = pairs.slice(0, 5).map(formatPair);
      return JSON.stringify({ token: args.address, top_pairs: top, total_pairs: pairs.length }, null, 2);
    }

    case 'dx_search': {
      const data = await dexGet(`/latest/dex/search?q=${encodeURIComponent(args.query)}`);
      const pairs = data.pairs || [];
      if (!pairs.length) return JSON.stringify({ error: 'No results found' });
      pairs.sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
      const top = pairs.slice(0, 8).map(formatPair);
      return JSON.stringify({ query: args.query, results: top, total: pairs.length }, null, 2);
    }

    case 'dx_trending_bsc': {
      const minLiq = args.min_liquidity || 10000;
      const minVol1h = args.min_volume_h1 || 5000;
      const data = await dexGet(`/latest/dex/tokens/trending/bsc`);
      const pairs = (data.pairs || []).filter((p: any) =>
        (p.liquidity?.usd || 0) >= minLiq &&
        (p.volume?.h1 || 0) >= minVol1h
      );
      pairs.sort((a: any, b: any) => (b.priceChange?.h1 || 0) - (a.priceChange?.h1 || 0));
      const top = pairs.slice(0, 15).map(formatPair);
      return JSON.stringify({ trending_bsc: top, filters: { min_liquidity: minLiq, min_volume_h1: minVol1h } }, null, 2);
    }

    case 'dx_new_pairs_bsc': {
      const minLiq = args.min_liquidity || 5000;
      const data = await dexGet(`/latest/dex/pairs/bsc/new`);
      const pairs = (data.pairs || []).filter((p: any) =>
        (p.liquidity?.usd || 0) >= minLiq
      );
      pairs.sort((a: any, b: any) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
      const top = pairs.slice(0, 15).map(formatPair);
      return JSON.stringify({ new_pairs_bsc: top, filter_min_liquidity: minLiq }, null, 2);
    }

    case 'dx_pair': {
      const data = await dexGet(`/latest/dex/pairs/${args.chain}/${args.pair_address}`);
      const pairs = data.pairs || [];
      if (!pairs.length) return JSON.stringify({ error: 'Pair not found' });
      return JSON.stringify(formatPair(pairs[0]), null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createServer() {
  const server = new Server(
    { name: 'dexscreener-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      return { content: [{ type: 'text' as const, text: result }], isError: false };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  return server;
}

async function startHttp() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => { transports[sid] = transport; },
        });
        transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  app.get('/mcp', async (req: any, res: any) => {
    const sid = req.headers['mcp-session-id'] as string;
    if (!sid || !transports[sid]) { res.status(400).send('Invalid session'); return; }
    await transports[sid].handleRequest(req, res);
  });

  app.delete('/mcp', async (req: any, res: any) => {
    const sid = req.headers['mcp-session-id'] as string;
    if (!sid || !transports[sid]) { res.status(400).send('Invalid session'); return; }
    await transports[sid].handleRequest(req, res);
  });

  app.get('/', (_req: any, res: any) => {
    res.json({ name: 'dexscreener-mcp', version: '1.0.0', status: 'ok', tools: TOOLS.length, endpoints: { mcp: '/mcp' } });
  });

  app.listen(port, () => {
    console.log(`DexScreener MCP Server listening on port ${port}`);
    console.log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);
  });
}

async function main() {
  if (process.argv.includes('--http')) await startHttp();
  else {
    const server = createServer();
    await server.connect(new StdioServerTransport());
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
