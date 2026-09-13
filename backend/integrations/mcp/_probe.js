const fs=require('node:fs');
const envRaw=fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env','utf8');
process.env.GRAPH_API_KEY=(envRaw.match(/^GRAPH_API_KEY=(.*)$/m)||[])[1]?.trim()||'';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const PROVIDERS = [
  { slug: 'uniswap-v3-ethereum', chain: 'mainnet', contractAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
  { slug: 'aave-v2-ethereum', chain: 'mainnet', contractAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9' },
  { slug: 'compound-v2-ethereum', chain: 'mainnet', contractAddress: '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B' },
  { slug: 'curve-ethereum', chain: 'mainnet', contractAddress: '0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5' },
  { slug: 'gmx-arbitrum', chain: 'arbitrum', contractAddress: '0x489ee077994B6658eAfA855C308275E8097C9565' },
];

const QUERY = `query StandardProtocolIntel {
  protocols(first: 1) { id name slug schemaVersion subgraphVersion type network totalValueLockedUSD cumulativeTotalRevenueUSD }
  usageMetricsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp dailyActiveUsers dailyTransactionCount }
  financialsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp totalRevenueUSD }
}`;

async function gatewayProbe(hashOrId, key) {
  for (const url of [
    `https://api.gateway.thegraph.com/api/${key}/subgraphs/id/${hashOrId}`,
    `https://api.gateway.thegraph.com/api/${key}/subgraphs/ipfs/${hashOrId}`,
  ]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const resp = await fetch(url, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: QUERY }),
        });
        const json = await resp.json().catch(() => ({}));
        const proto = json?.data?.protocols?.[0];
        if (proto && proto.name) return { url: url.replace(key, '***'), name: proto.name, tvl: proto.totalValueLockedUSD, slug: proto.slug, via: /ipfs/.test(url) ? 'ipfs' : 'id' };
      } finally { clearTimeout(timer); }
    } catch { /* try next */ }
  }
  return null;
}

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: '/Users/dushyantsingh/Downloads/Work/Credence/backend/integrations/mcp',
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe', version: '0.1.0' });
  await client.connect(transport);

  for (const p of PROVIDERS) {
    const r = await client.callTool({ name: 'get_top_subgraph_deployments', arguments: { chain: p.chain, contract_address: p.contractAddress } });
    const text = (r.content || []).map(c => c.text || '').join('').trim();
    const hashes = [...text.matchAll(/Qm[a-zA-Z0-9]{40,}/g)].map(m => m[0]);
    const top = hashes.slice(0, 3);
    let best = null;
    for (const h of top) {
      const res = await gatewayProbe(h, process.env.GRAPH_API_KEY);
      if (res) { best = { ...res, ipfs: h }; break; }
    }
    console.log(p.slug.padEnd(24), '->', JSON.stringify(best || { error: 'no live gateway hit', hashes: top.length }));
  }
  await client.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });