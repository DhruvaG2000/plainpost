import { AppError, messageSummary, summarizeThread, plainParts, decodePart } from './mail.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

export async function googleRequest(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(30000) }); }
  catch { throw new AppError(options.method && options.method !== 'GET' ? 'Google request interrupted. The operation may have completed; refresh your mailbox before retrying.' : 'Cannot reach Google. Check your internet connection.', 502); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error;
    const status = response.status === 401 || error === 'invalid_grant' ? 401 : response.status === 429 ? 429 : 502;
    const message = status === 401 ? 'Gmail authorization expired. Connect your Google account again.' : typeof error === 'object' ? error.message : data.error_description;
    throw new AppError(message || 'Google rejected the request.', status);
  }
  return data;
}

export async function exchangeToken(config, parameters, fetcher = fetch) {
  return googleRequest('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }).toString()
  }, fetcher);
}

export class Gmail {
  constructor(config, vault, accountId, fetcher = fetch) { this.config = config; this.vault = vault; this.accountId = accountId; this.fetcher = fetcher; }
  async accessToken(force = false) {
    const account = this.vault.data.accounts[this.accountId];
    if (!account) throw new AppError('Connect your Google account again.', 401);
    if (!force && account.expiresAt > Date.now() + 60000) return account.accessToken;
    // One refresh at a time per account, shared by concurrent thread requests.
    const locks = this.vault.refreshLocks ||= new Map();
    if (!locks.has(this.accountId)) {
      locks.set(this.accountId, (async () => {
        if (!account.refreshToken) throw new AppError('Connect your Google account again to renew access.', 401);
        const token = await exchangeToken(this.config, { grant_type: 'refresh_token', refresh_token: account.refreshToken }, this.fetcher);
        account.accessToken = token.access_token;
        account.expiresAt = Date.now() + token.expires_in * 1000;
        if (token.refresh_token) account.refreshToken = token.refresh_token;
        await this.vault.save();
        return account.accessToken;
      })().finally(() => locks.delete(this.accountId)));
    }
    return locks.get(this.accountId);
  }
  async request(path, { method = 'GET', body, params, retry = true } = {}) {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== '') url.searchParams.set(key, value);
    try {
      return await googleRequest(url, { method, headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, this.fetcher);
    } catch (error) {
      // Only reads are retried. Never automatically retry a send or draft write.
      if (error.status === 401 && retry && method === 'GET') { await this.accessToken(true); return this.request(path, { method, body, params, retry: false }); }
      throw error;
    }
  }
  profile() { return this.request('profile'); }
  async labels() { return (await this.request('labels')).labels || []; }
  async list({ q = '', pageToken } = {}) {
    const result = await this.request('threads', { params: { q, pageToken, maxResults: 30 } });
    const ids = result.threads || [];
    const threads = [];
    // Bounded batches avoid flooding Gmail with large numbers of requests.
    for (let i = 0; i < ids.length; i += 5) threads.push(...await Promise.all(ids.slice(i, i + 5).map(t => this.request(`threads/${encodeURIComponent(t.id)}`, { params: { format: 'metadata', metadataHeaders: undefined } }).then(summarizeThread))));
    return { threads, nextPageToken: result.nextPageToken || '', resultSizeEstimate: result.resultSizeEstimate || 0 };
  }
  async thread(id) {
    const thread = await this.request(`threads/${encodeURIComponent(id)}`, { params: { format: 'full' } });
    const messages = await Promise.all((thread.messages || []).map(async message => {
      const parts = plainParts(message.payload);
      const texts = await Promise.all(parts.map(async part => {
        const data = part.body?.data || (part.body?.attachmentId ? (await this.request(`messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).data : '');
        return decodePart(part, data);
      }));
      return { ...messageSummary(message), body: texts.join('\n\n'), hasPlainText: parts.length > 0 };
    }));
    return { id: thread.id, messages };
  }
  modify(id, addLabelIds, removeLabelIds) { return this.request(`threads/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds, removeLabelIds } }); }
  send(raw, threadId) { return this.request('messages/send', { method: 'POST', body: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } }); }
  async drafts({ pageToken } = {}) {
    const result = await this.request('drafts', { params: { maxResults: 30, pageToken } });
    return { drafts: result.drafts || [], nextPageToken: result.nextPageToken || '' };
  }
  async draft(id) {
    const draft = await this.request(`drafts/${encodeURIComponent(id)}`, { params: { format: 'full' } });
    const message = draft.message;
    const parts = plainParts(message.payload);
    const bodies = await Promise.all(parts.map(async part => decodePart(part, part.body?.data || (part.body?.attachmentId ? (await this.request(`messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).data : ''))));
    return { ...messageSummary(message), id: draft.id, messageIdResource: message.id, bcc: (message.payload.headers || []).find(h => h.name.toLowerCase() === 'bcc')?.value || '', body: bodies.join('\n\n'), hasPlainText: parts.length > 0, inReplyTo: (message.payload.headers || []).find(h => h.name.toLowerCase() === 'in-reply-to')?.value || '', hasAttachments: !!messageSummary(message).attachments.length };
  }
  saveDraft(raw, threadId, id) {
    return this.request(id ? `drafts/${encodeURIComponent(id)}` : 'drafts', { method: id ? 'PUT' : 'POST', body: { message: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } } });
  }
  sendDraft(id) { return this.request('drafts/send', { method: 'POST', body: { id } }); }
  async raw(id) { return Buffer.from((await this.request(`messages/${encodeURIComponent(id)}`, { params: { format: 'raw' } })).raw, 'base64url'); }
  async attachment(messageId, attachmentId) { return Buffer.from((await this.request(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)).data, 'base64url'); }
}
