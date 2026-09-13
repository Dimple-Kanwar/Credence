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

async function gatewayProbe(subId) {
  try {
    const resp = await fetch(`https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/${subId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY }),
    });
    const json = await resp.json().catch(() => ({}));
    const proto = json?.data?.protocols?.[0];
    if (proto && proto.name) {
      return `OK name=${proto.name} schema=${proto.schemaVersion} sv=${proto.subgraphVersion} tvl=${proto.totalValueLockedUSD} rev7d=${json?.data?.financialsDailySnapshots?.length || 0} snapshots`;
    }
    const firstErr = (json?.errors?.[0]?.message || '') || JSON.stringify(json).slice(0, 120);
    return 'FAIL ' + firstErr.slice(0, 120);
  } catch (e) { return 'ERR ' + String(e.message).slice(0, 100); }
}

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: __dirname,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe5', version: '0.1.0' });
  await client.connect(transport);

  for (const slug of PROVIDERS) {
    console.log('========== ' + slug + ' ==========');
    let sr;
    try {
      const r = await client.callTool({ name: 'search_subgraphs_by_keyword', arguments: { keyword: slug } });
      sr = JSON.parse((r.content || []).map(c => c.text || '').join('').trim());
    } catch (e) { console.log('search ERR', String(e.message).slice(0, 160)); continue; }
    for (const s of (sr.subgraphs || [])) {
      const name = (s.metadata || {}).displayName || '?';
      const id = s.id || '?';
      const ipfs = s.currentVersion?.subgraphDeployment?.ipfsHash || '?';
      console.log(`- ${name}  id=${id}  ipfs=${ipfs}`);
      console.log('    ' + await gatewayProbe(id));
    }
    if (!(sr.subgraphs || []).length) console.log('(no results, total=' + sr.total + ')');
  }
  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });