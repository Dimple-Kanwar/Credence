const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', '--header', `Authorization:Bearer ${process.env.GRAPH_API_KEY}`, 'https://subgraphs.mcp.thegraph.com/sse'],
    cwd: __dirname,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'probe7', version: '0.1.0' });
  await client.connect(transport);
  for (const kw of ['graph-network', 'graph network', 'network subgraph']) {
    try {
      const r = await client.callTool({ name: 'search_subgraphs_by_keyword', arguments: { keyword: kw } });
      const text = (r.content || []).map(c => c.text || '').join('').trim();
      let j; try { j = JSON.parse(text); } catch { j = null; }
      console.log('== ' + kw + ' total=' + (j?.total ?? '?') + ' ==');
      console.log(text.slice(0, 1600));
      console.log();
    } catch (e) { console.log(kw, 'ERR', String(e.message).slice(0, 120)); }
  }
  await client.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });