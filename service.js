"use strict";

const http = require("node:http");
const { Store } = require("./src/store");
const { createApp } = require("./src/app");
const { seed } = require("./src/seed");

const SERVICE_ID = "rove-beetle-prevention";
const SERVICE_NAME = "隐翅虫环境防控巡查";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

async function buildStore() {
  const dataFile = process.env.DATA_FILE || "";
  const store = await Store.loadOrCreate(dataFile, process.env.NO_SEED ? null : seed);
  return { store, dataFile };
}

function createServer(storeArg) {
  const store = storeArg || (() => {
    const fresh = new Store();
    seed(fresh);
    return fresh;
  })();
  const app = createApp(store, {
    persist: async () => {
      if (process.env.DATA_FILE) await store.saveToFile(process.env.DATA_FILE);
    },
  });
  return http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    app.handle(request, response);
  });
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    buildStore()
      .then(({ store }) => {
        createServer(store).listen(port, "127.0.0.1", () => {
          process.stdout.write(`${SERVICE_NAME} 已启动: http://127.0.0.1:${port}\n`);
        });
      })
      .catch((error) => {
        process.stderr.write("启动失败: " + error.message + "\n");
        process.exit(1);
      });
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, createApp, buildStore, healthPayload };
