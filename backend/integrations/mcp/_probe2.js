const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const PROVIDERS = [
  { slug: 'uniswap-v3-ethereum', chain: 'mainnet', contractAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
  { slug: 'aave-v2-ethereum', chain: 'mainnet', contractAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9' },
  { slug: 'compound-v2-ethereum', chain: 'mainnet', contractAddress: '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B' },
  { slug: 'curve-ethereum', chain: 'mainnet', contractAddress: '0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5' },
  { slug: 'gmx-arbitrum', chain: 'arbitrum', contractAddress: '0x489ee077994B6658eAfA855C308275E8097C9565' },
];

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: __dirname,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe2', version: '0.1.0' });
  await client.connect(transport);

  for (const p of PROVIDERS) {
    try {
      const r = await client.callTool({ name: 'get_top_subgraph_deployments', arguments: { chain: p.chain, contract_address: p.contractAddress } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      console.log('===== ' + p.slug + ' (' + p.chain + ') =====');
      console.log(text.slice(0, 900));
    } catch (e) { console.log('===== ' + p.slug + ' callTool ERROR ====='); console.log(String(e.message).slice(0, 400)); }
  }

  // raw gateway probe for the first uniswap hash
  const q = '{ protocols(first:1) { id name slug } }';
  for (const url of [
    `https://api.gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/ipfs/QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7`,
    `https://api.gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7`,
  ]) {
    try {
      const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
      console.log('GATEWAY', resp.status, url.replace(process.env.GRAPH_API_KEY, '***'));
      console.log(JSON.stringify(await resp.json().catch(() => ({}))).slice(0, 300));
    } catch (e) { console.log('GATEWAY ERR', url, String(e.message).slice(0, 200)); }
  }

  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });