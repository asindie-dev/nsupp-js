// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { NsuppRestClient, NsuppApiError, verifyWebhook } from './index';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Mock fetch — çağrıyı kaydeder + kuyruktaki yanıtı döner. Gerçek ağ YOK (unit tripwire uyumlu). */
function mockFetch(queue: Array<{ status: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body });
    const next = queue.shift() ?? { status: 200, json: { error: false, data: {} } };
    const payload = next.text ?? JSON.stringify(next.json ?? {});
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const base = { identifier: 'nsupp_pk_abc', secret: 's3cr3t' };

describe('@nsupp/rest-sdk', () => {
  it('kimlik doğrulama başlıkları: HTTP Basic + X-Cof-Tier; zarf açılır (data döner)', async () => {
    const m = mockFetch([{ status: 200, json: { error: false, data: { name: 'Acme' } } }]);
    const c = new NsuppRestClient({ ...base, fetch: m.fn });
    const data = await c.request<{ name: string }>('GET', '/v1/website/pk1');
    expect(data).toEqual({ name: 'Acme' });
    expect(m.calls[0]!.headers.Authorization).toBe('Basic ' + Buffer.from('nsupp_pk_abc:s3cr3t').toString('base64'));
    expect(m.calls[0]!.headers['X-Cof-Tier']).toBe('plugin');
    expect(m.calls[0]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk1');
  });

  it('hata zarfı → NsuppApiError (reason+code+status)', async () => {
    const m = mockFetch([{ status: 403, json: { error: true, reason: 'scope denied', code: 'scope_denied' } }]);
    const c = new NsuppRestClient({ ...base, fetch: m.fn });
    await expect(c.request('GET', '/v1/website/pk1/people/profiles')).rejects.toMatchObject({
      name: 'NsuppApiError',
      message: 'scope denied',
      code: 'scope_denied',
      status: 403,
    });
    expect(new NsuppApiError('x', 404).status).toBe(404);
  });

  it('query paramları + POST gövde + Content-Type', async () => {
    const m = mockFetch([{ status: 200, json: { error: false, data: { ok: true } } }]);
    const c = new NsuppRestClient({ ...base, fetch: m.fn });
    await c.request('GET', '/v1/website/pk1/helpdesk/search', { query: { query: 'kargo', locale: 'tr', empty: undefined } });
    expect(m.calls[0]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk1/helpdesk/search?query=kargo&locale=tr');
    await c.request('POST', '/v1/website/pk1/conversation/s1/message', { body: { content: 'merhaba' } });
    expect(m.calls[1]!.headers['Content-Type']).toBe('application/json');
    expect(m.calls[1]!.body).toBe('{"content":"merhaba"}');
  });

  it('website() kapsamı: yol kurar + tipli yardımcılar + escape-hatch request()', async () => {
    const m = mockFetch([
      { status: 200, json: { error: false, data: [] } }, // listConversations
      { status: 200, json: { error: false, data: { fingerprint: 'm1' } } }, // sendMessage
      { status: 200, json: { error: false, data: { participants: [] } } }, // listParticipants
      { status: 200, json: { error: false, data: { anything: 1 } } }, // escape hatch
    ]);
    const c = new NsuppRestClient({ ...base, websiteId: 'pk9', fetch: m.fn });
    const w = c.website();
    expect(w.websiteId).toBe('pk9');
    await w.listConversations({ page: 1 });
    expect(m.calls[0]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk9/conversations?page=1');
    await w.sendMessage('s1', 'hi');
    expect(m.calls[1]!.method).toBe('POST');
    expect(m.calls[1]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk9/conversation/s1/message');
    await w.listParticipants('s1');
    expect(m.calls[2]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk9/conversation/s1/participants');
    // escape hatch: kapsanmayan herhangi bir uç
    await w.request('GET', '/anything/custom');
    expect(m.calls[3]!.url).toBe('https://api.nsupp.com/cof/v1/website/pk9/anything/custom');
  });

  it('destek-farklılaştırıcı tipli yardımcılar (reply/note/contact/canned/order-notes) doğru yol+method kurar', async () => {
    const m = mockFetch(Array.from({ length: 12 }, () => ({ status: 200, json: { error: false, data: {} } })));
    const c = new NsuppRestClient({ ...base, websiteId: 'pk9', fetch: m.fn });
    const w = c.website();
    const B = 'https://api.nsupp.com/cof/v1/website/pk9';
    await w.emailReply('s1', 'yanıt');
    expect([m.calls[0]!.method, m.calls[0]!.url]).toEqual(['POST', `${B}/conversation/s1/email-reply`]);
    await w.marketplaceReply('s1', 'y');
    expect(m.calls[1]!.url).toBe(`${B}/conversation/s1/marketplace-reply`);
    await w.reviewReply('s1', 'y');
    expect(m.calls[2]!.url).toBe(`${B}/conversation/s1/review-reply`);
    await w.addInternalNote('s1', 'iç not');
    expect([m.calls[3]!.method, m.calls[3]!.url]).toEqual(['POST', `${B}/conversation/s1/note`]);
    await w.getContact('s1');
    expect(m.calls[4]!.url).toBe(`${B}/conversation/s1/contact`);
    await w.removeParticipant('s1', 'lee@acme.com');
    expect([m.calls[5]!.method, m.calls[5]!.url]).toEqual(['DELETE', `${B}/conversation/s1/participants/lee%40acme.com`]);
    await w.sendMessage('s1', 'x', [{ type: 'file', url: 'https://x/y.pdf' }]);
    expect(m.calls[6]!.body).toBe('{"content":"x","attachments":[{"type":"file","url":"https://x/y.pdf"}]}');
    await w.createCannedReply({ shortcut: 'iade', body: '3-5 gün' });
    expect([m.calls[7]!.method, m.calls[7]!.url]).toEqual(['POST', `${B}/canned-replies`]);
    await w.deleteCannedReply('cr1');
    expect([m.calls[8]!.method, m.calls[8]!.url]).toEqual(['DELETE', `${B}/canned-replies/cr1`]);
    await w.listOrderNotes('trendyol', 'TY-4471');
    expect(m.calls[9]!.url).toBe(`${B}/orders/notes?connector=trendyol&order=TY-4471`);
    await w.createOrderNote({ connectorId: 'trendyol', orderNumber: 'TY-4471', body: 'not' });
    expect([m.calls[10]!.method, m.calls[10]!.url]).toEqual(['POST', `${B}/orders/notes`]);
    await w.deleteOrderNote('on1');
    expect([m.calls[11]!.method, m.calls[11]!.url]).toEqual(['DELETE', `${B}/orders/notes/on1`]);
  });

  it('HEAD → void (2xx), 404 → NsuppApiError; baseUrl override + tier=website', async () => {
    const m = mockFetch([{ status: 200 }, { status: 404 }]);
    const c = new NsuppRestClient({ ...base, tier: 'website', baseUrl: 'http://localhost:8788/cof/', fetch: m.fn });
    await expect(c.request('HEAD', '/v1/website/pk1/conversation/s1')).resolves.toBeUndefined();
    expect(m.calls[0]!.headers['X-Cof-Tier']).toBe('website');
    expect(m.calls[0]!.url).toBe('http://localhost:8788/cof/v1/website/pk1/conversation/s1'); // sondaki / temizlendi
    await expect(c.request('HEAD', '/v1/website/pk1/conversation/nope')).rejects.toMatchObject({ status: 404 });
  });

  it('identifier/secret zorunlu; websiteId olmadan website() hata', () => {
    // @ts-expect-error kasıtlı eksik
    expect(() => new NsuppRestClient({ fetch: (() => {}) as never })).toThrow();
    const c = new NsuppRestClient({ ...base, fetch: (() => {}) as never });
    expect(() => c.website()).toThrow(/websiteId/);
  });
});

describe('verifyWebhook', () => {
  const secret = 'cof_whsec_test';
  const payload = '{"id":"evt_1","event":"message:received","data":{"x":1}}';
  const ts = 1_784_361_825_398;
  // Bağımsız oracle: sunucunun imzaladığı gibi HMAC-SHA256(`${ts};${body}`) (node:crypto).
  const sign = (t: number | string, body: string) =>
    createHmac('sha256', secret).update(`${t};${body}`).digest('hex');

  it('geçerli imza + taze timestamp → true', async () => {
    const ok = await verifyWebhook({ payload, signature: sign(ts, payload), timestamp: ts, secret, now: ts + 1000 });
    expect(ok).toBe(true);
  });
  it('kurcalanmış gövde → false', async () => {
    const ok = await verifyWebhook({ payload: payload + ' ', signature: sign(ts, payload), timestamp: ts, secret, now: ts + 1000 });
    expect(ok).toBe(false);
  });
  it('yanlış secret → false', async () => {
    const bad = createHmac('sha256', 'nope').update(`${ts};${payload}`).digest('hex');
    expect(await verifyWebhook({ payload, signature: bad, timestamp: ts, secret, now: ts + 1000 })).toBe(false);
  });
  it('5 dk penceresinden eski timestamp → false (replay)', async () => {
    const ok = await verifyWebhook({ payload, signature: sign(ts, payload), timestamp: ts, secret, now: ts + 6 * 60 * 1000 });
    expect(ok).toBe(false);
  });
  it('sayısal olmayan timestamp → false', async () => {
    expect(await verifyWebhook({ payload, signature: sign(ts, payload), timestamp: 'nope', secret, now: ts })).toBe(false);
  });
});
