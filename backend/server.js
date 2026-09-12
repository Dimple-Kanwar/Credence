require("dotenv").config();

const http = require("node:http");
const { PORT, HOST } = require("./config.js");
const { handleRoutes } = require("./routes.js");

const server = http.createServer((request, response) => {
  handleRoutes(request, response).catch((error) => {
    response.writeHead(error.statusCode || 500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message || "Backend request failed." }));
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Credence backend listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server, handle: handleRoutes };
