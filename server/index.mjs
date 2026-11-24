import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.mjs';
import { createApp } from './app.mjs';
import { loadB4RelayConfig } from './b4-relay.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Plainpost requires Node.js 22 or newer.');
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const port = Number(process.env.PORT || 4819);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
const url = new URL(appUrl);
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || Number(url.port || 80) !== port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('APP_URL must be an HTTP localhost or 127.0.0.1 URL matching PORT.');
const config = { appUrl, clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '', b4Relay: loadB4RelayConfig(process.env) };
const vault = await new Vault(resolve(root, process.env.DATA_DIR || 'data')).init();
const server = await createApp(config, vault);
server.on('error', error => { console.error(`Cannot start Plainpost: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`\n  Plainpost · plain text, full conversation\n  Local: ${appUrl}\n  Gmail: IMAP + SMTP · configure ~/.config/plainpost/mail.conf (npm run config:init)\n  b4 relay: ${config.b4Relay ? 'configured' : 'optional · see README.md'}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); });
