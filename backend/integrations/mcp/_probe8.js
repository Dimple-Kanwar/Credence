const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';

const CANDIDATES = [
  'D7L3s6muSYsxd2p3JB6FvmDGQaCWcWpvrs21RZRVoCvu',
  '9Co7EQe5PgW3ugCUJrJgRv4u9zdEuDJf8NvMWftNsBH8',
];

const Q = 'query { subgraphs(first: 1) { id displayName } }';
(async () => {
  for (const id of CANDIDATES) {
    try {
      const resp = await fetch('https://gateway.thegraph.com/api/' + process.env.GRAPH_API_KEY + '/subgraphs/id/' + id, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: Q }),
      });
      const json = await resp.json().catch(() => ({}));
      console.log(id, '-> HTTP', resp.status, JSON.stringify(json).slice(0, 300));
    } catch (e) { console.log(id, 'ERR', String(e.message).slice(0, 150)); }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });