const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const PROVIDERS = ['uniswap-v3-ethereum', 'aave-v2-ethereum', 'compound-v2-ethereum', 'curve-ethereum', 'gmx-arbitrum'];

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
  const client = new Client({ name: 'probe4', version: '0.1.0' });
  await client.connect(transport);

  for (const slug of PROVIDERS) {
    console.log('========== ' + slug + ' ==========');
    let sr;
    try {
      const r = await client.callTool({ name: 'search_subgraphs_by_keyword', arguments: { keyword: slug } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      sr = JSON.parse(text);
    } catch (e) { console.log('search ERR', String(e.message).slice(0, 200)); continue; }
    const subs = (sr.subgraphs || []).filter(s => (s.metadata||{}).displayName === slug);
    const pick = subs[0] || (sr.subgraphs || [])[0];
    if (!pick) { console.log('no subgraph found. total=', sr.total); continue; }
    const subId = pick.id;
    const ipfs = pick.currentVersion?.subgraphDeployment?.ipfsHash || null;
    console.log('subgraph id:', subId, ' ipfs:', ipfs, ' displayName:', pick.metadata?.displayName);

    for (const [label, name, args] of [
      ['by_subgraph_id', 'execute_query_by_subgraph_id', { subgraph_id: subId, query: QUERY }],
      ...(ipfs ? [['by_ipfs', 'execute_query_by_ipfs_hash', { ipfs_hash: ipfs, query: QUERY }]] : []),
    ]) {
      try {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content || []).map(c => c.text || '').join('').trim();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const proto = parsed?.data?.protocols?.[0] || (Array.isArray(parsed?.protocols) ? parsed.protocols[0] : null) || (Array.isArray(parsed) ? parsed[0] : null);
        console.log(label + ' ->', proto ? `OK name=${proto.name} schema=${proto.schemaVersion} sv=${proto.subgraphVersion} tvl=${proto.totalValueLockedUSD}` : ('no protocols field. raw: ' + text.slice(0, 260)));
      } catch (e) { console.log(label + ' ERR', String(e.message).slice(0, 200)); }
    }

    // gateway by subgraph id
    if (subId) {
      try {
        const resp = await fetch(`https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/${subId}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY }),
        });
        const json = await resp.json().catch(() => ({}));
        const proto = json?.data?.protocols?.[0];
        console.log('gateway_by_subid ->', proto ? `OK ${proto.name} tvl=${proto.totalValueLockedUSD}` : ('HTTP ' + resp.status + ' ' + JSON.stringify(json).slice(0, 200)));
      } catch (e) { console.log('gateway_by_subid ERR', String(e.message).slice(0, 200)); }
    }
  }
  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });