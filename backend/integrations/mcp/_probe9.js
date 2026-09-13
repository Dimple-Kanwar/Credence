const fs = require('node:fs');
const envRaw = fs.readFileSync('/Users/dushyantsingh/Downloads/Work/Credence/.env', 'utf8');
process.env.GRAPH_API_KEY = (envRaw.match(/^GRAPH_API_KEY=(.*)$/m) || [])[1]?.trim() || '';

const ID = '9Co7EQe5PgW3ugCUJrJgRv4u9zdEuDJf8NvMWftNsBH8';
const base = 'https://gateway.thegraph.com/api/' + process.env.GRAPH_API_KEY;

async function run(query) {
  const resp = await fetch(base + '/subgraphs/id/' + ID, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const json = await resp.json().catch(() => ({}));
  console.log(JSON.stringify(json).slice(0, 900));
  console.log();
  return json;
}

(async () => {
  console.log('--- subgraph fields ---');
  await run('{ __type(name: "Subgraph") { fields { name } } }');
  console.log('--- try name ---');
  await run('{ subgraphs(first: 2, orderBy: id) { id metadata { displayName } currentVersion { subgraphDeployment { id } } } }');
})();