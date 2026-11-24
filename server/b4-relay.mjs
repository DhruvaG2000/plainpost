import { spawn } from 'node:child_process';
import { addresses, AppError } from './mail.mjs';

export function loadB4RelayConfig(env) {
  if (!env.B4_RELAY_URL && !env.B4_RELAY_FROM) return null;
  const endpoint = URL.parse(env.B4_RELAY_URL || '');
  if (endpoint?.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('B4_RELAY_URL must be an HTTPS URL without credentials or a fragment.');
  }
  const from = env.B4_RELAY_FROM?.trim() || '';
  const senders = addresses(from);
  if (senders.length !== 1) throw new Error('B4_RELAY_FROM must contain one verified email address.');
  return { endpoint: endpoint.href, from, email: senders[0].email, patatt: env.PATATT_PATH || 'patatt' };
}

function signMessage(program, raw) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, ['sign'], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000, killSignal: 'SIGKILL' });
    const chunks = [];
    let size = 0;
    const failed = () => reject(new AppError('Could not sign with patatt. Check the executable and signing key available to the Plainpost user.', 502));
    child.on('error', failed);
    child.stdin.on('error', failed);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) { child.kill('SIGKILL'); failed(); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      const signed = Buffer.concat(chunks).toString('utf8');
      const headers = signed.split('\n\n', 1)[0];
      if (code !== 0 || !/^X-Developer-Signature:/mi.test(headers)) failed();
      else resolve(signed);
    });
    child.stdin.end(raw);
  });
}

export async function sendViaB4Relay(config, raw, fetcher) {
  // Match b4's web submission format, including LF line endings before signing.
  const signed = await signMessage(config.patatt, raw.replaceAll('\r\n', '\n'));
  let response, result;
  try {
    response = await fetcher(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'receive', messages: [signed] }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    });
    result = await response.json();
  } catch {
    throw new AppError('Could not confirm delivery through the b4 relay. Check the mailing list before retrying.', 502);
  }
  if (response.ok && result?.result === 'success') return { ok: true };
  if (result?.result === 'error' && typeof result.message === 'string') {
    throw new AppError('b4 relay rejected the message: ' + result.message.slice(0, 500), 502);
  }
  throw new AppError('Could not confirm delivery through the b4 relay. Check the mailing list before retrying.', 502);
}
