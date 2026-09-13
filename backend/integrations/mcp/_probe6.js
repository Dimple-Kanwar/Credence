const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const KEYWORDS = ['messari/uniswap-v3-ethereum', 'uniswap-v3', 'aave-v2', 'compound-v2', 'curve', 'gmx', 'standardized', 'messari/'];

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: __dirname,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe6', version: '0.1.0' });
  await client.connect(transport);
  for (const kw of KEYWORDS) {
    try {
      const r = await client.callTool({ name: 'search_subgraphs_by_keyword', arguments: { keyword: kw } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      let j; try { j = JSON.parse(text); } catch { j = null; }
      const names = (j?.subgraphs || []).map(s => (s.metadata || {}).displayName);
      console.log(kw.padEnd(34), '-> total=' + (j?.total ?? '?'), '[' + names.slice(0, 12).join(', ') + ']');
    } catch (e) { console.log(kw.padEnd(34), '-> ERR', String(e.message).slice(0, 120)); }
  }
  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });