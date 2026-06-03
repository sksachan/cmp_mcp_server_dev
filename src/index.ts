import { loadConfig } from "./config.js";
import { createHttpServer } from "./httpServer.js";

const config = loadConfig();
const server = createHttpServer(config);

server.listen(config.port, () => {
  console.log(`CMP MCP server listening on port ${config.port}`);
});
