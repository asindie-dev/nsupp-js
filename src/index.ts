// SPDX-FileCopyrightText: 2026 Asindie, Inc.
// SPDX-License-Identifier: Apache-2.0

// @nsupp/rest-sdk — nsupp /cof/v1 REST API için tipli, bağımlılıksız istemci (Node 18+ ve tarayıcı).
// Kimlik doğrulama (HTTP Basic + X-Cof-Tier), zarf açma ({error,data}), hata sınıfı + web-sitesi kapsamı.
// En-çok-kullanılan uçlar tipli yardımcılarla; KAPSANMAYAN her uç `request()` kaçış-kapısıyla erişilebilir (139/139).

export type Tier = 'plugin' | 'website';

export interface NsuppRestOptions {
  /**
   * Plugin token identifier (nsupp_pk_… / nsupp_wt_…). Omit when you authenticate with a USER
   * access token (`accessToken`) obtained through the OAuth authorization-code flow.
   */
  identifier?: string;
  /** Token secret (shown once). Omit when using `accessToken`. */
  secret?: string;
  /**
   * OAuth USER access token (`POST /v1/oauth/token`). Sent as `Authorization: Bearer …` per
   * RFC 6750, and NO `X-Cof-Tier` header is sent — the Bearer scheme already says what the
   * credential is, and requiring a proprietary header would break every standard OAuth client.
   * A user token reaches only the workspaces the consenting person belongs to AND your app is
   * installed in, carries the scopes that person consented to, and stops working the moment
   * they revoke your app.
   */
  accessToken?: string;
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
  throw new Error('no base64 encoder available');
}

const enc = encodeURIComponent;

/** Alt kutu otomatik-yönlendirme kuralı (Sub-inbox routing rule). */
export interface InboxRule {
  kind: 'email' | 'locale' | 'country' | 'segment' | 'data' | 'sla';
  op?: 'eq' | 'contains';
  value?: string;
  /** `data` kuralı için ziyaretçi özniteliği adı (ör. 'plan'). `$`/`_` önekleri reddedilir. */
  key?: string;
  /** `sla` kuralı için gün eşiği (1-365). Alternatif: value: 'overdue'. */
  slaWithinDays?: number;
}
/** Koşul bloğu: manual=true → kural yok (elle taşınır); değilse mode + rules (en fazla 10). */
export type InboxConditions =
  | { manual: true }
  | { manual: false; mode?: 'and' | 'or'; rules: InboxRule[] };

export class NsuppRestClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly tier: Tier;
  private readonly doFetch: typeof fetch;
  readonly defaultWebsiteId?: string;

  private readonly bearer: boolean;

  constructor(opts: NsuppRestOptions) {
    if (!opts || (!opts.accessToken && (!opts.identifier || !opts.secret)))
      throw new Error('NsuppRestClient: pass either accessToken (OAuth user token) or identifier + secret');
    this.baseUrl = (opts.baseUrl ?? 'https://api.nsupp.com/cof').replace(/\/$/, '');
    this.bearer = !!opts.accessToken;
    this.authHeader = opts.accessToken ? 'Bearer ' + opts.accessToken : 'Basic ' + base64(`${opts.identifier}:${opts.secret}`);
    this.tier = opts.tier ?? 'plugin';
    this.defaultWebsiteId = opts.websiteId;
    const f = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) throw new Error('NsuppRestClient: no global fetch — pass opts.fetch');
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
    // 🔴 Bearer'da tier başlığı GÖNDERİLMEZ: kimlik bilgisinin cinsini şemanın kendisi söyler.
    const headers: Record<string, string> = this.bearer
      ? { Authorization: this.authHeader }
      : { Authorization: this.authHeader, 'X-Cof-Tier': opts.tier ?? this.tier };
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
    if (!id) throw new Error('website(): websiteId is required (or set opts.websiteId)');
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
  /**
   * Bir konuşmanın mesajları (eskiden yeniye). Sayfalama imleci ÇİFTTİR: `before` = aldığın en
   * ESKİ mesajın `timestamp`i, `before_id` = aynı mesajın `fingerprint`i. İkisini birlikte gönder
   * — yalnız damga gönderirsen aynı milisaniyeyi paylaşan mesajlar ATLANIR.
   */
  getMessages<T = unknown>(
    sessionId: string,
    query?: { limit?: number | string; before?: string; before_id?: string },
  ): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/messages`, {
      query: query as RequestOptions['query'],
    });
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
  /**
   * Kişi özel alanlarını BİRLEŞTİR (kısmi güncelleme).
   * Tavanlar: istek başına 30, kişi başına 60 anahtar; anahtar ≤64, değer (JSON) ≤1024 karakter.
   * Tavanı aşan anahtar KIRPILMAZ, DÜŞÜRÜLÜR — kaç tanesinin düştüğü `X-Cof-Attributes-Dropped`
   * yanıt başlığındadır. `$…` (nsupp) ve `_…` (operatör) önekli anahtarlar reddedilir.
   */
  updatePersonData<T = unknown>(peopleId: string, data: Record<string, unknown>): Promise<T> {
    return this.request('PATCH', `/people/${enc(peopleId)}/data`, { body: data });
  }
  /** Kişi özel alanlarını TAM DEĞİŞTİR. Ayrılmış (`$…`/`_…`) anahtarlar KORUNUR — silinemez. */
  replacePersonData<T = unknown>(peopleId: string, data: Record<string, unknown>): Promise<T> {
    return this.request('PUT', `/people/${enc(peopleId)}/data`, { body: data });
  }

  // ── Alt kutular (Inbox) — otomatik yönlendirme kuralları dahil ──
  listInboxes<T = unknown>(): Promise<T> {
    return this.request('GET', '/inboxes');
  }
  // ── Şeffaflık günlüğü (salt-okur) — scope: website:audit ──
  /**
   * Çalışma alanı denetim kaydını oku. YAZMA YOLU YOKTUR: kaydı sistem üretir; eklenti yazabilseydi
   * iz sahtelenebilir ve kanıt olmaktan çıkardı. Toplama kapalıysa yanıt `enabled: false` der
   * (boş liste "hiç eylem olmadı" gibi okunurdu). Essentials altı planda yalnız en yeni 20 satır
   * döner ve filtreler yok sayılır (`locked.filters_disabled`) — kayıt SİLİNMEZ, yükseltmede geri gelir.
   */
  listAuditEvents<T = unknown>(query?: {
    from?: string;
    to?: string;
    operator?: string;
    action?: string;
    limit?: number;
  }): Promise<T> {
    return this.request('GET', '/audit', { query: query as RequestOptions['query'] });
  }

  // ── Ekip sohbeti — scope: website:team:chat ──
  /**
   * Ekibin GENEL kanalını oku. KAPSAM BİLEREK DAR: özel gruplar ve birebir mesajlar API'de YOKTUR —
   * o kanalların üyeliği KİŞİ kimliğine bağlıdır, API anahtarının arkasında kişi yoktur.
   * Silinen mesaj yerinde kalır (`content: ''`, `deleted: true`) — akışta delik açılmaz.
   *
   * Sayfalama imleci ISO DAMGADIR (opak jeton değil): `after` İLERİ yürür (poll), `before` GERİYE
   * yürür (geçmiş). Bir sonraki `before` = önceki sayfanın EN ESKİ `created_at`i; sayfa `limit`ten
   * kısaysa başa ulaşılmıştır.
   */
  listTeamChatMessages<T = unknown>(query?: { after?: string; before?: string; limit?: number }): Promise<T> {
    return this.request('GET', '/team-chat', { query: query as RequestOptions['query'] });
  }
  /**
   * Genel ekip kanalına mesaj yaz (dağıtım bitti · SLA aşılmak üzere · nöbet devri). ZİYARETÇİYE GİTMEZ.
   * Yazar adı SENİN eklenti kimliğinden gelir, gövdeden değil: bir eklenti kendini başka bir uygulama
   * ya da bir operatör gibi gösteremez; panel bu mesajları "Uygulama" rozetiyle işaretler.
   */
  postTeamChatMessage<T = unknown>(content: string): Promise<T> {
    return this.request('POST', '/team-chat', { body: { content } });
  }

  /**
   * Bir KANALA yaz — uygulaman o kanalın ÜYESİ olmalıdır (`not_in_channel` yoksa). Genel kanal tek
   * istisnadır: orada üyelik örtüktür. `website:team:chat:public` scope'un varsa AÇIK kanallara
   * üyeliksiz de yazabilirsin; özel kanal yine üyelik ister.
   *
   * `blocks` ile düğme koyabilirsin; tıklama, uygulamanın Etkileşim URL'ine `payload=<JSON>` olarak
   * gelir. `postAt` verirsen mesaj kuyruğa girer (en çok 120 gün) ve `scheduled_id` döner.
   * Kanal başına yaklaşık saniyede bir yazma sınırı vardır; aşarsan 429 + `Retry-After` gelir.
   */
  postTeamChannelMessage<T = unknown>(
    channelId: string,
    body: {
      content?: string;
      blocks?: unknown[];
      attachments?: Array<{ type: string; name?: string; url?: string }>;
      postAt?: string | number;
    },
  ): Promise<T> {
    const { postAt, ...rest } = body;
    return this.request('POST', `/team-chat/channels/${enc(channelId)}/messages`, {
      body: { ...rest, ...(postAt !== undefined ? { post_at: postAt } : {}) },
    });
  }
  /**
   * Bir KİŞİYE uygulama olarak DM yaz. Slack bunu iki çağrıda yapar (`conversations.open` +
   * `chat.postMessage`); burada tek çağrı yeter, çünkü DM kimliği ÜYE KÜMESİNDEN türer.
   * Bota DM yazılamaz (iki otomasyon birbirine yanıt verirse bu bir döngüdür, özellik değil).
   */
  sendTeamDirectMessage<T = unknown>(userId: string, content: string, blocks?: unknown[]): Promise<T> {
    return this.request('POST', '/team-chat/dm', { body: { user_id: userId, content, ...(blocks ? { blocks } : {}) } });
  }
  /**
   * Agent surface of one DM: its title, a transient status line and suggested prompts.
   *
   * Partial update: only the fields you pass change. `null` CLEARS a field; omitting it leaves
   * it alone — if those meant the same thing, taking a status line back down would be impossible.
   * Your app must have the agent surface enabled, otherwise 403 `agent_not_enabled`.
   */
  setAgentThread<T = unknown>(
    channelId: string,
    patch: { title?: string | null; status?: string | null; suggested_prompts?: string[] },
  ): Promise<T> {
    return this.request('POST', `/team-chat/assistant/${encodeURIComponent(channelId)}`, { body: patch });
  }
  /**
   * The files this app can see: lists, plus every file attached to a message in a channel the app
   * can see. There is no separate file store behind this — a file is either a list or an
   * attachment on a message — so a file disappears exactly when the thing holding it does.
   *
   * Newest first. Page with `after` + `after_id` (the last row's `updated_at` and `file_id`);
   * a page shorter than `limit` means you reached the end.
   *
   * `nav` picks a sub-view: `all` (default), `lists`, `canvases`. The per-person views
   * (assigned / recent / starred) are refused with `nav_requires_person` — an app token has no
   * person behind it, and an empty array would read as "you have none".
   */
  listTeamFiles<T = unknown>(query?: {
    nav?: 'all' | 'lists' | 'canvases';
    /** Comma-separated kinds. Narrows, and combines with `nav` — an empty intersection returns nothing. */
    types?: string;
    /** Title search. An EMPTY string means everything, not nothing. */
    q?: string;
    /** Only `all` for app tokens: mine/shared are per-person and answer 400. */
    scope?: 'all';
    /** Only `updated` for app tokens: `recent` (recently viewed) is per-person and answers 400. */
    sort?: 'updated';
    /** Person id — the filter dialog's `From`. Different from `scope`; both can be sent. */
    from?: string;
    /** Channel id — the filter dialog's `In`. */
    in?: string;
    /** ISO timestamp — only files updated at or after it. */
    since?: string;
    limit?: number;
    after?: string;
    after_id?: string;
  }): Promise<T> {
    return this.request('GET', '/team-chat/files', { query });
  }
  /**
   * Creates a canvas. There is NO "create a file" call: the files plane is a union (lists +
   * canvases + attachments), so you create a canvas — or a list, which has its own endpoint.
   * Pass `channel_id` to hang it on a channel tab; the channel must be visible to your app.
   */
  createTeamCanvas<T = unknown>(body?: { title?: string; body?: { id: string; type: string; text?: string }[]; channel_id?: string }): Promise<T> {
    return this.request('POST', '/team-chat/docs', { body: body ?? {} });
  }
  /**
   * Reads a canvas. THE BODY IS AN ARRAY OF BLOCKS, not one blob of HTML: each block keeps a
   * stable `id` because comments and reactions attach to a block, not to a character offset.
   */
  getTeamCanvas<T = unknown>(docId: string): Promise<T> {
    return this.request('GET', `/team-chat/docs/${encodeURIComponent(docId)}`);
  }
  /**
   * Replaces the title, the body, or both — an omitted field is left alone. The body you send is
   * the WHOLE body, so read, modify, write, and keep the ids of blocks you did not touch: a new
   * id means a new block, and a comment attached to the old one has nothing left to point at.
   */
  updateTeamCanvas<T = unknown>(docId: string, body: { title?: string; body?: { id: string; type: string; text?: string }[] }): Promise<T> {
    return this.request('PUT', `/team-chat/docs/${encodeURIComponent(docId)}`, { body });
  }
  /**
   * Copies a TEMPLATE canvas into a new, independent canvas. The title and blocks are copied and
   * nothing else: shares are not carried over (that would publish your draft into rooms you never
   * chose), the access level resets, and the copy is not itself a template.
   */
  useTeamCanvasTemplate<T = unknown>(docId: string): Promise<T> {
    return this.request('POST', `/team-chat/docs/${encodeURIComponent(docId)}/use-template`);
  }
  /**
   * Opens a canvas to a channel. Your app can only share with a CHANNEL, never with a person:
   * a person-share decides something on that person's behalf and there is no person behind an
   * API key. You need edit access yourself, and the channel must already be visible to you.
   */
  shareTeamCanvas<T = unknown>(docId: string, body: { channel_id: string; can_edit?: boolean }): Promise<T> {
    return this.request('POST', `/team-chat/docs/${encodeURIComponent(docId)}/shares`, { body });
  }
  /**
   * Sets (or removes) the canvas cover image.
   *
   * The image is NOT uploaded here — upload it first through your account's upload endpoint and
   * pass the resulting URL. Only a URL from your own account is accepted; anything else is
   * rejected with `cover_not_owned`, because a cover republishes that file inside your canvas.
   * Pass `cover_url: null` to remove the cover — the stored object is deleted with it.
   */
  setTeamCanvasCover<T = unknown>(docId: string, body: { cover_url: string | null }): Promise<T> {
    return this.request('PUT', `/team-chat/docs/${encodeURIComponent(docId)}/cover`, { body });
  }
  /**
   * Every comment on a canvas, oldest first. Comments hang off a BLOCK, not off the document:
   * key your mirror on `block_id`. Names are not returned — only `user_id` — because a name is
   * personal data your integration does not need to do its job.
   */
  listTeamCanvasComments<T = unknown>(docId: string): Promise<T> {
    return this.request('GET', `/team-chat/docs/${encodeURIComponent(docId)}/comments`);
  }
  /**
   * Comments on one block of a canvas. You only need READ access — commenting does not change
   * the document. The block must exist in the body; otherwise the comment would never be shown
   * to anyone, so it answers 404 `block_not_found` instead of storing it.
   */
  commentOnTeamCanvasBlock<T = unknown>(docId: string, blockId: string, body: { body: string }): Promise<T> {
    return this.request('POST', `/team-chat/docs/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(blockId)}/comments`, { body });
  }
  /**
   * Version history of a canvas, newest first. The list carries NO bodies — ten full bodies
   * would make opening the history more expensive than opening the document. Fetch the one you
   * need with `getTeamCanvasVersion`. A version with `restored_from` set is a restore, and that
   * is the audit trail: who went back to which version, visible in the history itself.
   */
  listTeamCanvasVersions<T = unknown>(docId: string): Promise<T> {
    return this.request('GET', `/team-chat/docs/${encodeURIComponent(docId)}/versions`);
  }
  /** One version, with its full body. */
  getTeamCanvasVersion<T = unknown>(docId: string, versionId: string): Promise<T> {
    return this.request('GET', `/team-chat/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}`);
  }
  /**
   * Copies a canvas into a NEW, independent document. Seeing it is enough — a copy never
   * changes the source. Shares, access level, template flag, channel and cover are NOT carried
   * over: the copy is yours and is open to nobody. Emits team:file:created.
   */
  copyTeamCanvas<T = unknown>(docId: string): Promise<T> {
    return this.request('POST', `/team-chat/docs/${encodeURIComponent(docId)}/copy`);
  }
  /**
   * Deletes a canvas. Requires edit access and cannot be undone: comments, reactions, versions,
   * shares and stars go with it. Emits team:doc:deleted.
   */
  deleteTeamCanvas<T = unknown>(docId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/docs/${encodeURIComponent(docId)}`);
  }
  /**
   * Details of one file — the card behind the ⓘ button. Visibility comes from the FILES PLANE
   * itself: a file you cannot see is not in the plane, so it answers 404 rather than 403.
   *
   * There is no `size` and no `sha`, and that is deliberate rather than missing: the plane does
   * not store them, and a canvas or a list has no bytes at all — one is a block array, the
   * other a set of rows. Returning 0 would tell you we measured and found nothing.
   */
  getTeamFile<T = unknown>(fileId: string): Promise<T> {
    return this.request('GET', `/team-chat/files/${encodeURIComponent(fileId)}`);
  }
  /**
   * The built-in canvas templates, with their bodies already resolved to English text — pass a
   * body straight to `createTeamCanvas`. Titles and bodies are English on purpose: this is the
   * developer surface, and an integration cannot be expected to resolve an eight-language key
   * catalogue. Templates live in code, not in your account, so every workspace sees the same
   * set and nobody can delete one by accident.
   */
  listTeamCanvasTemplates<T = unknown>(): Promise<T> {
    return this.request('GET', '/team-chat/templates');
  }
  /**
   * Revokes one share on a canvas. Requires edit access — the same gate as sharing, because a
   * viewer cutting off other people's access would overrule whoever decided who may read it.
   * A share id from another canvas answers 404: an id must never become a side door.
   */
  revokeTeamCanvasShare<T = unknown>(docId: string, shareId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/docs/${encodeURIComponent(docId)}/shares/${encodeURIComponent(shareId)}`);
  }
  /**
   * Step 1 of an upload: asks for an upload URL for a file you are about to send.
   *
   * Uploading is TWO STEPS on purpose. This call returns `upload_url` and `file_id`; you then
   * PUT the raw bytes to that URL (no auth header needed — the URL itself is signed and
   * short-lived), and it answers with the stored file's address.
   *
   * The extension is checked HERE, before you send anything: being told "this type is not
   * allowed" after uploading 20 MB would waste your bandwidth and your time.
   */
  getTeamFileUploadUrl<T = unknown>(body: { filename: string }): Promise<T> {
    return this.request('POST', '/team-chat/files/upload-url', { body });
  }
  /**
   * Step 2: PUT the raw bytes to the URL from step 1. The filename comes from the signed
   * ticket, not from this call, so the extension check cannot be side-stepped by renaming.
   */
  async uploadTeamFileBytes<T = unknown>(uploadUrl: string, bytes: Uint8Array | Blob): Promise<T> {
    const res = await fetch(uploadUrl, { method: 'PUT', body: bytes as BodyInit });
    return (await res.json()) as T;
  }
  /** Partial patch: an omitted field is untouched. `todo_mode: true` ensures the three to-do columns exist. */
  updateTeamList<T = unknown>(
    listId: string,
    patch: { title?: string; description?: string | null; todo_mode?: boolean },
  ): Promise<T> {
    return this.request('PATCH', `/team-chat/lists/${encodeURIComponent(listId)}`, { body: patch });
  }
  /** Starts a CSV export. Returns a job_id; the job is already complete and EXPIRES after 24h. */
  startTeamListExport<T = unknown>(listId: string): Promise<T> {
    return this.request('POST', `/team-chat/lists/${encodeURIComponent(listId)}/export`, { body: {} });
  }
  /** Job state + download_url. A job id from another list answers 404; an expired job answers 410. */
  getTeamListExport<T = unknown>(listId: string, jobId: string): Promise<T> {
    return this.request('GET', `/team-chat/lists/${encodeURIComponent(listId)}/export/${encodeURIComponent(jobId)}`);
  }
  /** The CSV bytes. Authenticated like every other call — the link is not a capability. */
  downloadTeamListExport<T = unknown>(listId: string, jobId: string): Promise<T> {
    return this.request('GET', `/team-chat/lists/${encodeURIComponent(listId)}/export/${encodeURIComponent(jobId)}/download`);
  }
  /** Who a list is open to, plus its access level. Lists and canvases run through ONE permission rule. */
  getTeamListShares<T = unknown>(listId: string): Promise<T> {
    return this.request('GET', `/team-chat/lists/${encodeURIComponent(listId)}/shares`);
  }
  /** Opens a list to a channel your app can see. Sharing the same channel twice UPDATES the permission. */
  shareTeamList<T = unknown>(listId: string, channelId: string, canEdit?: boolean): Promise<T> {
    return this.request('POST', `/team-chat/lists/${encodeURIComponent(listId)}/shares`, {
      body: canEdit === undefined ? { channel_id: channelId } : { channel_id: channelId, can_edit: canEdit },
    });
  }
  /** Revokes one share. A share id from another list answers 404 — an id is never a side door. */
  revokeTeamListShare<T = unknown>(listId: string, shareId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/lists/${encodeURIComponent(listId)}/shares/${encodeURIComponent(shareId)}`);
  }
  /** Rows in a list, in order. A list is a small database: each row carries values keyed by FIELD ID. */
  listTeamListItems<T = unknown>(listId: string): Promise<T> {
    return this.request('GET', `/team-chat/lists/${encodeURIComponent(listId)}/items`);
  }
  /** One row with its values. A row id from another list answers 404 — an id is never a side door. */
  getTeamListItem<T = unknown>(listId: string, itemId: string): Promise<T> {
    return this.request('GET', `/team-chat/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`);
  }
  /**
   * Adds a row. `initial_fields` is keyed by FIELD ID; unknown keys are dropped rather than
   * stored, and every value is normalised to its column's type — a select only keeps a value
   * that exists in that column's options.
   */
  createTeamListItem<T = unknown>(listId: string, body: { initial_fields?: Record<string, unknown> }): Promise<T> {
    return this.request('POST', `/team-chat/lists/${encodeURIComponent(listId)}/items`, { body });
  }
  /** Updates a row. PARTIAL: a field you do not send is left alone — editing one cell never clears another. */
  updateTeamListItem<T = unknown>(listId: string, itemId: string, body: { fields: Record<string, unknown> }): Promise<T> {
    return this.request('PATCH', `/team-chat/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, { body });
  }
  /** Deletes one row. */
  deleteTeamListItem<T = unknown>(listId: string, itemId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`);
  }
  /**
   * Deletes many rows in one call — a SEPARATE endpoint on purpose, so "delete a row" and
   * "delete a hundred rows" are never the same request. The answer names what was deleted AND
   * what was not found: saying "all gone" would hide the ones that were not.
   */
  deleteTeamListItems<T = unknown>(listId: string, body: { item_ids: string[] }): Promise<T> {
    return this.request('POST', `/team-chat/lists/${encodeURIComponent(listId)}/items/delete`, { body });
  }
  /**
   * Turns a file into a PUBLIC link that anyone holding it can open — no login, no token.
   *
   * The link points at our gateway, never at the raw storage address. That is what makes
   * revoking real: revoke deletes the token and the gateway starts answering 404. Handing out
   * the raw address instead would be an exposure you could never take back.
   *
   * Idempotent: asking twice returns the SAME link, so a link you already shared keeps working.
   * Only files with bytes can be shared — a list or a canvas has nothing to download.
   */
  shareTeamFilePublicly<T = unknown>(fileId: string): Promise<T> {
    return this.request('POST', `/team-chat/files/${encodeURIComponent(fileId)}/public`);
  }
  /** Revokes the public link. The gateway answers 404 afterwards — the link truly stops working. */
  revokeTeamFilePublicLink<T = unknown>(fileId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/files/${encodeURIComponent(fileId)}/public`);
  }
  /**
   * Edits a canvas SECTION BY SECTION instead of replacing the whole body.
   *
   * This is how you avoid the read-modify-write race: with a full-body write, anything a
   * colleague changed between your read and your write is silently overwritten. Here you name
   * only the block you are touching.
   *
   * Changes are applied IN ORDER, each on the result of the previous one, and it is ALL OR
   * NOTHING — if one change fails, none are applied, because a half-edited document is a state
   * you never asked for and cannot undo.
   *
   * Operations: insert_at_start · insert_at_end · insert_before · insert_after · replace ·
   * delete. The last four need a `section_id` — use `lookupTeamCanvasSections` to find one.
   */
  editTeamCanvas<T = unknown>(docId: string, body: { changes: Array<{ operation: string; section_id?: string; blocks?: unknown[] }> }): Promise<T> {
    return this.request('POST', `/team-chat/docs/${encodeURIComponent(docId)}/edit`, { body });
  }
  /**
   * Finds sections (blocks) by type and/or text. The ids it returns are exactly what
   * `editTeamCanvas` takes as `section_id`, so the two together give you find-and-replace.
   * An unknown type is an error, not an empty result: a typo must not look like "nothing here".
   */
  lookupTeamCanvasSections<T = unknown>(docId: string, q?: { section_types?: string; contains_text?: string }): Promise<T> {
    const qs = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => !!v) as [string, string][]).toString();
    return this.request('GET', `/team-chat/docs/${encodeURIComponent(docId)}/sections${qs ? `?${qs}` : ''}`);
  }
  /**
   * Deletes a file. The files plane is a UNION, so deletion is dispatched by kind: a message
   * attachment is removed from the message it lives in (the message itself stays), while a
   * canvas or a list is deleted through its OWN endpoint — asking here answers 400 and tells
   * you which endpoint to use. Any public link on the file is revoked with it.
   */
  deleteTeamFile<T = unknown>(fileId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/files/${encodeURIComponent(fileId)}`);
  }
  /** Lists in this account. A list is a small database — rows with typed columns — not a to-do. */
  listTeamLists<T = unknown>(): Promise<T> {
    return this.request('GET', '/team-chat/lists');
  }
  /**
   * Creates an empty list. Give it columns next: a list with no columns is a table with no shape,
   * so nothing can be written into it yet. Pass `channel_id` to hang it on a channel tab.
   */
  createTeamList<T = unknown>(body: { title: string; description?: string; channel_id?: string }): Promise<T> {
    return this.request('POST', '/team-chat/lists', { body });
  }
  /**
   * Adds one typed column. `created_at`/`updated_at`/`created_by` are filled in by us and refused
   * as writes — letting an app set "created at" would let it rewrite when a row happened.
   * Reusing a `key` answers 409 rather than overwriting, so existing data can never be hidden.
   *
   * A `select` column's options carry colour: `{ value, label, color? }`. The cell stores the
   * `value`, so renaming an option never strands old rows. `color` comes from a closed palette
   * (default `gray`) — free hex is refused so both themes can guarantee a readable chip.
   */
  addTeamListField<T = unknown>(
    listId: string,
    body: { key: string; type: string; label: string; options?: { value: string; label: string; color?: TeamListOptionColor }[] },
  ): Promise<T> {
    return this.request('POST', `/team-chat/lists/${encodeURIComponent(listId)}/fields`, { body });
  }
  /**
   * Appends text to a message you posted with `stream: true`, so a long answer appears as it is
   * written. Send ONLY the new chunk — the append happens on our side, because read-modify-write
   * from your side loses a chunk whenever two arrive close together.
   * Always finish with `done: true`, including on your own error paths: a message left in the
   * growing state is one the reader watches forever.
   */
  streamTeamMessage<T = unknown>(messageId: string, patch: { text?: string; done?: boolean }): Promise<T> {
    return this.request('POST', `/team-chat/messages/${encodeURIComponent(messageId)}/stream`, { body: patch });
  }
  /**
   * YALNIZ BİR KİŞİNİN gördüğü mesaj (Slack `chat.postEphemeral`). İki taraf da kanalda olmalıdır:
   * göremediği bir kanalın İÇİNDE birine mesaj göstermek, o kanalın varlığını sızdırırdı.
   */
  postTeamEphemeral<T = unknown>(channelId: string, userId: string, content: string): Promise<T> {
    return this.request('POST', `/team-chat/channels/${enc(channelId)}/ephemeral`, { body: { user_id: userId, content } });
  }
  /** KENDİ yazdığın mesajı düzenle. Başkasının mesajı 403 — bir otomasyon insanın sözünü değiştiremez. */
  updateTeamChatMessage<T = unknown>(messageId: string, content: string): Promise<T> {
    return this.request('PATCH', `/team-chat/${enc(messageId)}`, { body: { content } });
  }
  /** KENDİ mesajını sil. Arşivli kanalda düzenleme kapalıdır ama silme açıktır. */
  deleteTeamChatMessage<T = unknown>(messageId: string): Promise<T> {
    return this.request('DELETE', `/team-chat/${enc(messageId)}`);
  }
  /**
   * Tıklamadan gelen `trigger_id` ile bir pencere aç. Tetikleyici GÖNDERİLDİKTEN 3 SANİYE sonra
   * ölür: `views.open`ı, tıklamayı 200 ile yanıtlamadan ÖNCE çağır.
   * Pencerenin içeriği SENİN sayfandır (iframe), bir görünüm JSON'u değil.
   */
  openTeamView<T = unknown>(triggerId: string, view: { url: string; title?: string }): Promise<T> {
    return this.request('POST', '/team-chat/views/open', { body: { trigger_id: triggerId, view } });
  }
  /**
   * Bir kişinin App Home sekmesini yayınla (Slack `views.publish`). Görünüm KİŞİ BAŞINADIR ve en
   * çok 100 blok taşır; boş bir `blocks` dizisi sekmeyi temizler.
   */
  publishTeamAppHome<T = unknown>(userId: string, blocks: unknown[]): Promise<T> {
    return this.request('POST', '/team-chat/views/publish', { body: { user_id: userId, view: { type: 'home', blocks } } });
  }
  /**
   * Uygulamanın görebildiği ekip kanallarını listele (Slack `conversations.list` karşılığı).
   *
   * GÖRÜNÜRLÜK: üyesi olduğun her kanal + genel kanal (üyelik örtük) + `website:team:chat:public`
   * onaylıysa açık kanallar. Birebir/özel mesajlar (DM) HİÇBİR koşulda listelenmez.
   * Arşivli kanal varsayılan olarak LİSTEDE kalır (`exclude_archived: true` ile süzülür) —
   * "bu kanal kapandı" diyebilmen için onu görmen gerekir.
   *
   * Sayfalama imleci ÇİFTTİR: `after` = önceki sayfanın son satırının `created_at`i, `after_id`
   * = aynı satırın `channel_id`si. İkisini birlikte gönder — yalnız damga gönderirsen aynı
   * milisaniyede kurulmuş kanallar atlanır. Sayfa `limit`ten kısaysa liste bitmiştir.
   */
  listTeamChatChannels<T = unknown>(query?: { after?: string; after_id?: string; limit?: number; exclude_archived?: boolean }): Promise<T> {
    return this.request('GET', '/team-chat/channels', { query: query as RequestOptions['query'] });
  }
  /** Tek bir ekip kanalının bilgisi (Slack `conversations.info`). Göremediğin kanal 404'tür. */
  getTeamChatChannel<T = unknown>(channelId: string): Promise<T> {
    return this.request('GET', `/team-chat/channels/${enc(channelId)}`);
  }
  /** Ekip mesajlarında ara (çok kanallı; sonuç hangi kanalda olduğunu taşır). */
  searchTeamChat<T = unknown>(query: { q: string; limit?: number }): Promise<T> {
    return this.request('GET', '/team-chat/search', { query: query as RequestOptions['query'] });
  }
  /** Bir mesajın thread yanıtları. */
  listTeamChatReplies<T = unknown>(messageId: string): Promise<T> {
    return this.request('GET', `/team-chat/${enc(messageId)}/replies`);
  }
  /** Thread'e yanıt yaz. */
  postTeamChatReply<T = unknown>(messageId: string, content: string): Promise<T> {
    return this.request('POST', `/team-chat/${enc(messageId)}/replies`, { body: { content } });
  }
  /** Tepki ekle/kaldır. Emoji KODU gönder (`white_check_mark`), karakter değil. */
  reactToTeamChatMessage<T = unknown>(messageId: string, emoji: string): Promise<T> {
    return this.request('POST', `/team-chat/${enc(messageId)}/reactions`, { body: { emoji } });
  }
  /** Mesajı sabitle / sabitlemeyi kaldır. */
  pinTeamChatMessage<T = unknown>(messageId: string): Promise<T> {
    return this.request('POST', `/team-chat/${enc(messageId)}/pin`);
  }
  /** Mesajı başka bir kanala ilet. */
  forwardTeamChatMessage<T = unknown>(messageId: string, note?: string): Promise<T> {
    return this.request('POST', `/team-chat/${enc(messageId)}/forward`, { body: note ? { note } : {} });
  }

  // ── Kişisel veri paylaşımı (0179) — scope: website:disclosure ──
  /**
   * Operatör bu görüşmede müşteriyi doğruladı mı ve hangi siparişler paylaşılabilir?
   * DOĞRULAMA API'de YOKTUR: kapıyı açmak operatörün canlı temasta verdiği güven kararıdır
   * (API'den açılabilseydi sipariş-no + e-posta denemeleri programatik bir sorgulayıcıya dönerdi).
   */
  getDisclosure<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/disclosure`);
  }
  /**
   * Doğrulanmış siparişi sohbete KART olarak gönder (no + durum + kargo + takip linki).
   * Kart SUNUCUDA kurulur — gönderdiğiniz başlık/görsel/link YOK SAYILIR. Kartta alıcının adı,
   * adresi, telefonu ve e-postası ASLA bulunmaz. Doğrulanmamışsa 403 `disclosure_unverified`.
   */
  shareOrder<T = unknown>(sessionId: string, body: { connector_id: string; order_number: string }): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/disclosure/share`, { body: { kind: 'order', ...body } });
  }
  /** Ürün kartı gönder — katalog kişisel veri DEĞİL, doğrulama kapısı YOKTUR. */
  shareProduct<T = unknown>(sessionId: string, body: { connector_id: string; product_id: string }): Promise<T> {
    return this.request('POST', `/conversation/${enc(sessionId)}/share-product`, { body });
  }

  // ── Arşiv (0175) — duruma DİK eksen ──
  /** Görüşme durumu + arşiv bayrağı. */
  getConversationState<T = unknown>(sessionId: string): Promise<T> {
    return this.request('GET', `/conversation/${enc(sessionId)}/state`);
  }
  /**
   * Durum ve/veya arşiv bayrağını değiştir (ikisi tek çağrıda gönderilebilir).
   * Arşiv YALNIZ çözülmüş görüşmede geçerlidir (açık talebi arşivlemek onu operatörden gizlerken
   * müşteriyi bekletirdi → 400 `not_resolved`). Yeniden açılınca arşiv damgası OTOMATİK temizlenir.
   */
  setConversationState<T = unknown>(
    sessionId: string,
    /** Geriye uyum: düz string = yalnız durum ('resolved'). Nesne = durum ve/veya arşiv. */
    body: 'pending' | 'unresolved' | 'resolved' | { state?: 'pending' | 'unresolved' | 'resolved'; archived?: boolean },
  ): Promise<T> {
    const payload = typeof body === 'string' ? { state: body } : body;
    return this.request('PATCH', `/conversation/${enc(sessionId)}/state`, { body: payload });
  }

  getInbox<T = unknown>(inboxId: string): Promise<T> {
    return this.request('GET', `/inbox/${enc(inboxId)}`);
  }
  /**
   * Alt kutu oluştur. `conditions` ile OTOMATİK yönlendirme kurulur:
   *   { manual: false, mode: 'and'|'or', rules: [{ kind, op, value, key?, slaWithinDays? }] }
   * kind: email · locale · country · segment · data · sla. `data` kuralı `key` ister (ör. 'plan');
   * `$`/`_` önekli anahtarlar reddedilir. `sla` için value:'overdue' ya da slaWithinDays (1-365);
   * birden çok SLA kuralı eşleşirse EN DAR eşik kazanır.
   */
  createInbox<T = unknown>(body: {
    name: string;
    emoji?: string;
    priority?: number;
    access?: { general: boolean; operatorEmails?: string[] };
    conditions?: InboxConditions;
  }): Promise<T> {
    return this.request('POST', '/inbox', { body });
  }
  /** Alt kutuyu güncelle (yalnız gönderilen alanlar değişir). */
  saveInbox<T = unknown>(
    inboxId: string,
    body: {
      name?: string;
      emoji?: string;
      priority?: number;
      access?: { general: boolean; operatorEmails?: string[] };
      conditions?: InboxConditions;
    },
  ): Promise<T> {
    return this.request('PUT', `/inbox/${enc(inboxId)}`, { body });
  }
  deleteInbox<T = unknown>(inboxId: string): Promise<T> {
    return this.request('DELETE', `/inbox/${enc(inboxId)}`);
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

// ── Web Hook signature verification ────────────────────────────────────────────
/**
 * The closed colour palette a `select` list option may use. It is a NAME, not a pixel value:
 * light and dark themes paint the same name differently, which is what keeps chips readable in
 * both. Free hex is refused by the server on purpose.
 */
export type TeamListOptionColor =
  | 'indigo'
  | 'blue'
  | 'cyan'
  | 'pink'
  | 'yellow'
  | 'green'
  | 'gray'
  | 'red'
  | 'purple'
  | 'orange'
  | 'brown';

export interface WebhookVerifyInput {
  /** The RAW request body, exactly as received (do NOT re-parse/re-serialize — that changes the bytes). */
  payload: string;
  /** The X-Cof-Signature header (hex HMAC-SHA256). */
  signature: string;
  /** The X-Cof-Request-Timestamp header (the value is part of the signed string). */
  timestamp: string | number;
  /** Your web hook signing secret (cof_whsec_… for website hooks, or your plugin secret). */
  secret: string;
  /** Replay window in seconds; deliveries older than this are rejected. Default 300 (5 min). */
  toleranceSec?: number;
  /** Injectable clock (ms since epoch) for testing. Default Date.now(). */
  now?: number;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) unavailable — verify web hooks on a Node 18+/worker/browser runtime.');
  const encoder = new TextEncoder();
  const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an nsupp Web Hook delivery. Recomputes HMAC-SHA256(`${timestamp};${rawBody}`, secret) over the
 * RAW body, compares it to X-Cof-Signature in constant time, and rejects stale timestamps (replay defense).
 * Returns true only when the signature matches AND the timestamp is within the tolerance window.
 *
 * @example
 * const ok = await verifyWebhook({
 *   payload: rawBody,                                  // the exact bytes you received
 *   signature: req.headers['x-cof-signature'],
 *   timestamp: req.headers['x-cof-request-timestamp'],
 *   secret: process.env.NSUPP_WEBHOOK_SECRET,
 * });
 * if (!ok) return res.status(400).end();
 */
export async function verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
  const { payload, signature, timestamp, secret, toleranceSec = 300, now = Date.now() } = input;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now - tsNum) > toleranceSec * 1000) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp};${payload}`);
  return timingSafeEqualHex(String(signature), expected);
}

// ── Identity verification (visitor e-mail signing) ─────────────────────────────
/** Kanonik biçimde kırpılan baytlar: space, \t, \n, \r, \v, \f — SADECE bunlar. */
const IDENTITY_TRIM_BYTES = [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c];

/**
 * Kanonik e-posta biçimi: baş/sondaki 6 ASCII boşluk baytı atılır, sonra YALNIZ A-Z → a-z eşlenir.
 * ASCII-dışı harfler (İ, Ö, ß…) OLDUĞU GİBİ kalır — bilinçli ve dokümante bir sınır.
 *
 * NİÇİN `trim()` / `toLowerCase()` kullanılmıyor: bu imzayı müşterinin sunucusu (Go, PHP, Python…)
 * üretir, biz doğrularız — yani kural beş uygulamada BAYT BAYT aynı olmak zorunda. Dilin hazır
 * fonksiyonları bunu sağlamıyor: 'İSTANBUL@X.com' JS/Python'da "i̇stanbul@x.com" (U+0130 iki koda
 * ayrışır), Go'da "istanbul@x.com", PHP'de "İstanbul@x.com" verir; Unicode kırpma da ayrışır
 * (PHP trim yalnız ASCII, diğerleri U+00A0 gibi boşlukları da atar). Tek ortak payda, aralığı
 * elle kontrol eden bu kod-birimi döngüsüdür. SADELEŞTİRMEYİN — diller arası imza uyumu kırılır.
 */
export function canonicalIdentityEmail(email: string): string {
  // Sunucudaki `canonicalIdentityEmail` ile AYNI savunma: düz JS'ten null/undefined gelebilir ve
  // burada patlamak kafa karıştırıcı bir iç hata verirdi. Boş girdi sessizce imzalanmaz — net hata
  // `signIdentity`de üretilir (fail-closed orada, savunma burada).
  email = String(email ?? '');
  let start = 0;
  let end = email.length;
  while (start < end && IDENTITY_TRIM_BYTES.includes(email.charCodeAt(start))) start++;
  while (end > start && IDENTITY_TRIM_BYTES.includes(email.charCodeAt(end - 1))) end--;
  let out = '';
  for (let i = start; i < end; i++) {
    const code = email.charCodeAt(i);
    // Vekil çiftler (>= 0xD800) bu aralığa hiç girmez; yarımlar sırayla eklenip aynen geri birleşir.
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : email[i];
  }
  return out;
}

/**
 * Giriş yapmış kullanıcının e-postasını çalışma-alanına özel gizli anahtarla imzalar:
 * HMAC-SHA256(canonicalIdentityEmail(email), secret), küçük harf hex. Widget bu imzayı taşıdığında
 * ziyaretçinin kimliği doğrulanmış sayılır (aksi hâlde e-posta yalnızca kullanıcının iddiasıdır).
 *
 * Gizli anahtar tarayıcıya ASLA konmaz: imza yalnız sizin sunucunuzda üretilir ve sayfaya
 * hazır hex olarak gömülür. Anahtar istemciye sızarsa herkes istediği kimliği taklit edebilir.
 *
 * @example
 * // Sunucu tarafı — oturumdaki kullanıcı için:
 * const signature = await signIdentity(session.user.email, process.env.NSUPP_IDENTITY_SECRET);
 * // → sayfaya: window.$nsupp.push(['set', 'user:email', [session.user.email, signature]])
 */
export async function signIdentity(email: string, secret: string): Promise<string> {
  // FAIL-CLOSED: boş e-posta imzalanmaz. `signIdentity('')` geçerli GÖRÜNEN bir hex döndürüyordu;
  // geliştirici `signIdentity(user.email, S)` yazar, oturumda e-posta boşsa hiçbir yerde hata çıkmaz
  // ve kimlik ASLA doğrulanmaz (sunucu e-postasız iddiayı zaten reddeder). Sessiz bir çıkmaz — tam
  // olarak bu yardımcının önlemek için var olduğu hata sınıfı. Artık çağrı anında patlar.
  const canonical = canonicalIdentityEmail(email);
  if (!canonical) throw new Error('signIdentity: email is empty — nothing to sign. Read it from the logged-in session before calling.');
  return hmacSha256Hex(secret, canonical);
}

/** Options for {@link signIdentityJwt}. */
export interface SignIdentityJwtOptions {
  /** Token lifetime in seconds (default 3600). Keep it short — this is the whole point of a JWT. */
  ttlSeconds?: number;
  /** Trusted display name. Unlike a name sent from the browser, this one is signed. */
  name?: string;
  /**
   * Trusted visitor attributes (plan, segments, order count…). Keys starting with `$` or `_` are
   * reserved for the server's own trust marks and are dropped — you cannot self-certify.
   */
  attributes?: Record<string, unknown>;
  /** Override "now" in milliseconds. For tests only. */
  nowMs?: number;
}

/**
 * Sign a logged-in user's identity as a short-lived HS256 JWT.
 *
 * ── WHY PREFER THIS OVER {@link signIdentity} ─────────────────────────────────────────────────
 * The plain HMAC signature is a pure function of the e-mail: it never expires and is not bound to
 * a session or device. If it ever leaks, that person can be impersonated FOREVER, from anywhere,
 * and the only way to revoke it is rotating the workspace secret — which breaks every user at
 * once. A JWT carries `exp`, so a leaked token dies on its own.
 *
 * The second gain is trust: `name` and `attributes` inside the token are signed by YOUR backend.
 * Attributes sent from the browser are only a claim — a verified visitor could still assert
 * `segments: ['vip']` and jump the priority queue. Signed ones cannot be forged.
 *
 * Both formats are accepted while your workspace stays in `hmac` (transition) mode, so you can
 * migrate page by page. Switch the workspace to `jwt` mode once you are done — that is what stops
 * open-ended signatures from being accepted at all.
 *
 * @example
 * const token = await signIdentityJwt(session.user.email, process.env.NSUPP_IDENTITY_SECRET, {
 *   ttlSeconds: 900,
 *   name: session.user.fullName,
 *   attributes: { plan: 'enterprise', segments: ['vip'] },
 * });
 * // → window.$nsupp.push(['set', 'user:email', [session.user.email, token]])
 */
export async function signIdentityJwt(
  email: string,
  secret: string,
  opts: SignIdentityJwtOptions = {},
): Promise<string> {
  // Same fail-closed rule as signIdentity: an empty e-mail produces a token that looks valid and
  // never verifies, which is exactly the silent dead end this helper exists to prevent.
  const canonical = canonicalIdentityEmail(email);
  if (!canonical) throw new Error('signIdentityJwt: email is empty — nothing to sign. Read it from the logged-in session before calling.');
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const ttl = Math.max(1, Math.floor(opts.ttlSeconds ?? 3600));
  const claims: Record<string, unknown> = { sub: canonical, iat: now, exp: now + ttl };
  const name = typeof opts.name === 'string' ? opts.name.trim() : '';
  if (name) claims.name = name;
  if (opts.attributes) {
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(opts.attributes)) {
      const key = k.trim();
      // Dropped rather than sent: the server rejects reserved prefixes anyway, and silently
      // shipping a key that will be ignored is how "I set it and nothing happened" bugs start.
      if (!key || key.startsWith('$') || key.startsWith('_') || v === undefined) continue;
      attrs[key] = v;
    }
    if (Object.keys(attrs).length) claims.attributes = attrs;
  }
  const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) unavailable — sign identity tokens on a Node 18+/worker runtime.');
  const key = await subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)));
  const sigB64 = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${sigB64}`;
}

export default NsuppRestClient;
