// @posthubify/rest-sdk — nsupp /cof/v1 REST API için tipli, bağımlılıksız istemci (Node 18+ ve tarayıcı).
// Kimlik doğrulama (HTTP Basic + X-Cof-Tier), zarf açma ({error,data}), hata sınıfı + web-sitesi kapsamı.
// En-çok-kullanılan uçlar tipli yardımcılarla; KAPSANMAYAN her uç `request()` kaçış-kapısıyla erişilebilir (139/139).

export type Tier = 'plugin' | 'website';

export interface NsuppRestOptions {
  /** Plugin token identifier (nsupp_pk_… / nsupp_wt_…). */
  identifier: string;
  /** Token secret (bir kez gösterilir). */
  secret: string;
  /** Tier — GET/HEAD=read, aksi=write yetkisi bu tier'a göre değerlendirilir. Varsayılan 'plugin'. */
  tier?: Tier;
  /** API kökü. Varsayılan 'https://api.nsupp.com/cof'. Kendi kurulumunuz için override edin. */
  baseUrl?: string;
  /** Kapsamlı çağrılar için varsayılan web sitesi public key'i (client.website() argümansız kullanılabilsin). */
  websiteId?: string;
  /** fetch enjeksiyonu (test / global fetch olmayan runtime). Varsayılan global fetch. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Bu istek için tier override. */
  tier?: Tier;
}

/** API hata zarfından ({error:true,reason,code}) türetilen tipli hata. */
export class NsuppApiError extends Error {
  readonly code?: string;
  readonly status: number;
  constructor(reason: string, status: number, code?: string) {
    super(reason);
    this.name = 'NsuppApiError';
    this.status = status;
    this.code = code;
  }
}

function base64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(s, 'utf8').toString('base64');
  throw new Error('base64 encoder bulunamadı');
}

const enc = encodeURIComponent;

export class NsuppRestClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly tier: Tier;
  private readonly doFetch: typeof fetch;
  readonly defaultWebsiteId?: string;

  constructor(opts: NsuppRestOptions) {
    if (!opts || !opts.identifier || !opts.secret) throw new Error('NsuppRestClient: identifier ve secret gerekli');
    this.baseUrl = (opts.baseUrl ?? 'https://api.nsupp.com/cof').replace(/\/$/, '');
    this.authHeader = 'Basic ' + base64(`${opts.identifier}:${opts.secret}`);
    this.tier = opts.tier ?? 'plugin';
    this.defaultWebsiteId = opts.websiteId;
    const f = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) throw new Error('NsuppRestClient: global fetch yok — opts.fetch verin');
    this.doFetch = f;
  }

  /** Ham istek — zarfı açar, hata zarfında NsuppApiError fırlatır. HEAD → void. Tüm 139 uç bununla erişilebilir. */
  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const upper = method.toUpperCase();
    const headers: Record<string, string> = { Authorization: this.authHeader, 'X-Cof-Tier': opts.tier ?? this.tier };
    const hasBody = opts.body !== undefined && upper !== 'GET' && upper !== 'HEAD';
    if (hasBody) headers['Content-Type'] = 'application/json';
    const res = await this.doFetch(url, { method: upper, headers, body: hasBody ? JSON.stringify(opts.body) : undefined });
    if (upper === 'HEAD') {
      if (!res.ok) throw new NsuppApiError('not_found', res.status);
      return undefined as T;
    }
    const raw = await res.text();
    let json: unknown = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        throw new NsuppApiError('invalid_response', res.status);
      }
    }
    const env = json as { error?: boolean; reason?: string; code?: string; data?: T };
    if (env && env.error === true) throw new NsuppApiError(env.reason ?? 'error', res.status, env.code);
    if (!res.ok) throw new NsuppApiError('http_' + res.status, res.status);
    return env.data as T;
  }

  /** Bir web sitesine (public key) sabitlenmiş tipli kapsam. */
  website(websiteId?: string): WebsiteScope {
    const id = websiteId ?? this.defaultWebsiteId;
    if (!id) throw new Error('website(): websiteId gerekli (veya opts.websiteId verin)');
    return new WebsiteScope(this, id);
  }
}

/** Bir web sitesine sabitlenmiş, en-çok-kullanılan uçların tipli sarmalayıcısı. Kapsanmayan uçlar: `request()`. */
export class WebsiteScope {
  constructor(
    private readonly client: NsuppRestClient,
    readonly websiteId: string,
  ) {}
  private path(sub: string): string {
    return `/v1/website/${enc(this.websiteId)}${sub}`;
  }
  /** Bu web sitesine sabitlenmiş ham istek (tipli sarmalayıcısı olmayan HERHANGİ bir /v1 alt-yolu). */
  request<T = unknown>(method: string, sub: string, opts?: RequestOptions): Promise<T> {
    return this.client.request<T>(method, this.path(sub), opts);
  }

  // ── Website ──
  get<T = unknown>(): Promise<T> {
    return this.request('GET', '');
  }

  // ── Conversations / Conversation ──
  listConversations<T = unknown>(query?: RequestOptions['query']): Promise<T> {
    return this.request('GET', '/conversations', { query });
  }
  getConversation<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}`);
  }
  createConversation<T = unknown>(body: unknown): Promise<T> {
    return this.request('POST', '/conversation', { body });
  }
  getMessages<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/messages`);
  }
  sendMessage<T = unknown>(sessionId: string, content: string, attachments?: unknown[]): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/message`, { body: { content, ...(attachments ? { attachments } : {}) } });
  }
  /** İç ekip notu (private note; müşteriye gitmez). Scope: website:conversation:notes. */
  addInternalNote<T = unknown>(sessionId: string, content: string): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/note`, { body: { content } });
  }
  /** E-posta ticket'ına yanıt (Microsoft/e-posta kanalına teslim). Scope: website:conversation:messages. */
  emailReply<T = unknown>(sessionId: string, content: string): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/email-reply`, { body: { content } });
  }
  /** Pazaryeri mesajı/Q&A yanıtı (konnektör üzerinden teslim). Scope: website:marketplace. */
  marketplaceReply<T = unknown>(sessionId: string, content: string): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/marketplace-reply`, { body: { content } });
  }
  /** Ürün yorumu yanıtı (çift-cevap CAS kilidi). Scope: website:reviews. */
  reviewReply<T = unknown>(sessionId: string, content: string): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/review-reply`, { body: { content } });
  }
  setConversationState<T = unknown>(sessionId: string, state: string): Promise<T> {
    return this.request('PATCH', `/conversation/${enc(sessionId)}/state`, { body: { state } });
  }
  updateConversationMeta<T = unknown>(sessionId: string, meta: unknown): Promise<T> {
    return this.request('PATCH', `/conversation/${enc(sessionId)}/meta`, { body: meta });
  }
  markRead<T = unknown>(sessionId: string): Promise<T> {
    return this.request('PATCH', `/conversation/${enc(sessionId)}/read`);
  }
  /** Görüşmenin müşteri kişisi (kime yanıt: email/ad/people_id). Scope: website:people:profiles. */
  getContact<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/contact`);
  }
  listParticipants<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/participants`);
  }
  addParticipant<T = unknown>(sessionId: string, operatorEmail: string): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/participants`, { body: { operator_email: operatorEmail } });
  }
  removeParticipant<T = unknown>(sessionId: string, operatorEmail: string): Promise<T> {
    return this.request('DELETE', `/conversation/${enc(sessionId)}/participants/${enc(operatorEmail)}`);
  }

  // ── Canned replies (composer macros) — Scope: website:canned ──
  listCannedReplies<T = unknown>(): Promise<T> {
    return this.request('GET', '/canned-replies');
  }
  createCannedReply<T = unknown>(body: { shortcut: string; body: string; title?: string }): Promise<T> {
    return this.request('POST', '/canned-replies', { body });
  }
  updateCannedReply<T = unknown>(id: string, body: unknown): Promise<T> {
    return this.request('PATCH', `/canned-replies/${enc(id)}`, { body });
  }
  deleteCannedReply<T = unknown>(id: string): Promise<T> {
    return this.request('DELETE', `/canned-replies/${enc(id)}`);
  }

  // ── Order notes (eDesk Order notes; AES-GCM at rest) — Scope: website:orders:notes ──
  listOrderNotes<T = unknown>(connector: string, order: string): Promise<T> {
    return this.request('GET', '/orders/notes', { query: { connector, order } });
  }
  createOrderNote<T = unknown>(body: { connectorId: string; orderNumber: string; body: string; conversationId?: string }): Promise<T> {
    return this.request('POST', '/orders/notes', { body });
  }
  deleteOrderNote<T = unknown>(id: string): Promise<T> {
    return this.request('DELETE', `/orders/notes/${enc(id)}`);
  }

  // ── People ──
  listPeople<T = unknown>(query?: RequestOptions['query']): Promise<T> {
    return this.request('GET', '/people/profiles', { query });
  }
  getPerson<T = unknown>(peopleId: string): Promise<T> {
    return this.request('GET', `/people/${enc(peopleId)}`);
  }
  createPerson<T = unknown>(body: unknown): Promise<T> {
    return this.request('POST', '/people/profile', { body });
  }

  // ── Helpdesk ──
  listArticles<T = unknown>(): Promise<T> {
    return this.request('GET', '/helpdesk/articles');
  }
  searchArticles<T = unknown>(query: string, locale?: string): Promise<T> {
    return this.request('GET', '/helpdesk/search', { query: { query, locale } });
  }
  getArticleFeedback<T = unknown>(articleId: string): Promise<T> {
    return this.request('GET', `/helpdesk/article/${enc(articleId)}/feedback`);
  }

  // ── Campaigns ──
  listCampaigns<T = unknown>(): Promise<T> {
    return this.request('GET', '/campaigns');
  }
  createCampaign<T = unknown>(body: unknown): Promise<T> {
    return this.request('POST', '/campaign', { body });
  }

  // ── Visitors ──
  listVisitors<T = unknown>(): Promise<T> {
    return this.request('GET', '/visitors');
  }
  countVisitors<T = unknown>(): Promise<T> {
    return this.request('GET', '/visitors/count');
  }
}

export default NsuppRestClient;
