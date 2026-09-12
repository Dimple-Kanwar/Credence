function readJsonBody(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, x-payment, agentkit",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, origin) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
  });
  response.end(body);
}

function urlPath(request) {
  return new URL(request.url, "http://backend.local").pathname;
}

module.exports = { readJsonBody, sendJson, sendText, urlPath };
