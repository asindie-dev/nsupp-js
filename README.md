# @nsupp/rest-sdk

Typed, dependency-free client for the **nsupp `/cof/v1` REST API**. Works in Node 18+ and the browser.

Handles HTTP Basic auth + the `X-Cof-Tier` header, unwraps the `{ error, data }` envelope, throws a typed `NsuppApiError` on failures, and gives you a website-scoped helper. Every one of the 152 endpoints is reachable — the common ones (including the support differentiators: email/marketplace/review replies, internal notes, canned replies, order notes) as typed methods, the rest via the `request()` escape hatch.

## Install

```bash
npm install @nsupp/rest-sdk
```

## Quickstart

```ts
import { NsuppRestClient, NsuppApiError } from '@nsupp/rest-sdk';

const nsupp = new NsuppRestClient({
  identifier: process.env.NSUPP_IDENTIFIER!, // nsupp_pk_… / nsupp_wt_…
  secret: process.env.NSUPP_SECRET!,
  tier: 'plugin',                            // 'plugin' | 'website'
  websiteId: '8f3c1d…',                      // default website public key
  // baseUrl: 'https://api.nsupp.com/cof',   // override for your own deployment
});

const site = nsupp.website();               // scoped to websiteId above

const website = await site.get();
const convos = await site.listConversations({ page: 1 });
await site.sendMessage('session_1', 'Hi 👋 — how can we help?');
await site.addParticipant('session_1', 'lee@acme.com');

try {
  await site.getPerson('missing');
} catch (e) {
  if (e instanceof NsuppApiError) console.error(e.status, e.code, e.message);
}
```

## Escape hatch — any of the 152 endpoints

```ts
// website-scoped
await site.request('PATCH', '/helpdesk/article/a_1/alternate', { body: { alternate_article_id: 'a_2' } });

// or fully custom
await nsupp.request('GET', '/v1/website/8f3c…/campaign-templates');
```

## Errors

`NsuppApiError` carries `message` (the API `reason`), `code` (stable machine code, e.g. `scope_denied`), and `status`.

See the full endpoint reference at **/docs/references/rest-api** (each endpoint has a live "Try it" console).

## License

Licensed under the [Apache License 2.0](./LICENSE).

"nsupp" and the nsupp logo are trademarks of Asindie, Inc. The license grants no trademark rights — see the
[trademark policy](https://github.com/asindie-dev/nsupp/blob/main/TRADEMARK.md) for what use is permitted.
