const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const QUERY = `query StandardProtocolIntel {
  protocols(first: 1) { id name slug schemaVersion subgraphVersion type network totalValueLockedUSD cumulativeTotalRevenueUSD }
  usageMetricsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp dailyActiveUsers dailyTransactionCount }
  financialsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp totalRevenueUSD }
}`;

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: __dirname,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe3', version: '0.1.0' });
  await client.connect(transport);

  const results = {};

  // 1) execute by ipfs hash — top uniswap + top aave + top compound hashes from earlier run
  const ipfs = {
    'uniswap': 'QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7',
    'aave': 'QmdwBHGxokamYsLfMVk6fXfry3Ss9emEiTy6wptd1ecysG',
    'compound': 'QmZ2LVu8b1J9F92CDRnDKX4CcM21zSNjb9ogdRfMxVCFrg',
  };
  for (const [k, h] of Object.entries(ipfs)) {
    try {
      const r = await client.callTool({ name: 'execute_query_by_ipfs_hash', arguments: { ipfs_hash: h, query: QUERY } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      results['execute_by_ipfs_' + k] = text.slice(0, 400);
    } catch (e) { results['execute_by_ipfs_' + k] = 'ERR ' + String(e.message).slice(0, 200); }
  }

  // 2) keyword search variants
  for (const kw of ['uniswap-v3-ethereum', 'aave-v2-ethereum', 'messari uniswap', 'messari', 'uniswap v3']) {
    try {
      const r = await client.callTool({ name: 'search_subgraphs_by_keyword'.replace('subgraphs','subgraphs').replace('key_word','keyword'), arguments: { keyword: kw } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      results['search:' + kw] = text.slice(0, 500);
    } catch (e) { results['search:' + kw] = 'ERR ' + String(e.message).slice(0, 200); }
  }

  // 3) schema by ipfs hash (does deployment exist / does it expose protocols?)
  try {
    const r = await client.callTool({ name: 'get_schema_by_ipfs_hash', arguments: { ipfs_hash: 'QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7' } });
    results.schemaByIpfsUniswap = (r.content || []).map(c => c.text || '').join('').slice(0, 600);
  } catch (e) { results.schemaByIpfsUniswap = 'ERR ' + String(e.message).slice(0, 200); }

  for (const [k, v] of Object.entries(results)) {
    console.log('===== ' + k + ' =====');
    console.log(v);
    console.log();
  }
  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });