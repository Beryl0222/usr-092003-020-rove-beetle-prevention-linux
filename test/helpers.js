"use strict";

const http = require("node:http");
const { Store } = require("../src/store");
const { seed } = require("../src/seed");
const { createApp } = require("../src/app");

const TOKENS = {
  district: "district-demo-token",
  inspector: "inspector-demo-token",
  school: "school-demo-token",
  property: "property-demo-token",
};

async function withServer(run, { useSeed = true } = {}) {
  const store = new Store();
  if (useSeed) seed(store);
  const app = createApp(store);
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const client = async (method, path, body, token) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };
  try {
    await run({ client, store, base });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { withServer, TOKENS };
