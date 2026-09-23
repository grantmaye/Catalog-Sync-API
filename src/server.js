import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openCatalog } from './catalog.js';
import { createApp } from './app.js';

const token = process.env.API_TOKEN;
if (!token || token.length < 24) throw new Error('Set API_TOKEN to a random value of at least 24 characters');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1 to 65535');
const filename = process.env.DB_PATH ?? './data/catalog.sqlite';
mkdirSync(dirname(filename), { recursive: true });
const catalog = openCatalog(filename);
const app = createApp({ catalog, token, logger: entry => console.log(JSON.stringify(entry)) });
app.listen(port, '127.0.0.1', () => console.log(`Catalog API: http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  app.close(() => { catalog.close(); process.exit(0); });
});
