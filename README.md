# @snapnedit/embed

Loads the full [snapnedit](https://snapnedit.com) editor into your page as a sandboxed
iframe and gives you a typed handle to drive it. Browser-only, zero runtime dependencies;
React is an optional peer.

```sh
npm install @snapnedit/embed
```

The script tag below needs no install — it is served from `https://snapnedit.com/embed/v1.js`.

## Script tag

```html
<div id="editor" style="height: 640px"></div>
<script src="https://snapnedit.com/embed/v1.js" data-key="pk_live_..." data-target="#editor"></script>
```

Auto-mounts into `data-target`. `data-token`, `data-locale` and `data-config` (a JSON
`EmbedConfig`) are also read. Without `data-key`/`data-token`, call `window.Snapnedit.mount()`
yourself. Each loader tag auto-mounts **exactly once** — the tag is stamped with
`data-snapnedit-mounted` when it is claimed, so two loader tags on one page get one editor
each, in document order.

### DOM events

An auto-mounted embed has no handle to call `on()` on, so the loader mirrors the two
lifecycle events onto the container element as bubbling `CustomEvent`s:

| Event | `detail` |
| --- | --- |
| `snapnedit:ready` | `{ version, editor }` — `editor` is the `EditorHandle`, your hook for `on(...)`, `export()`, `run()`, … |
| `snapnedit:error` | `{ code, message }` — every error the editor reports, including a failed mount and an expired session (`token_expired`). Also logged with `console.error`. |

```js
document.addEventListener('snapnedit:ready', (e) => e.detail.editor.on('job', console.log));
document.addEventListener('snapnedit:error', (e) => console.warn(e.detail.code, e.detail.message));
```

### Token refresh

`mount()` answers the frame's `token-expiring` report by calling your `getToken` and handing
the frame the result. A token that is **already expired** is reported to your listeners once
and then retried on an exponential backoff (1s, 2s, 4s … capped at 30s) — the frame backs its
own reports off on the same ladder, and the loader collapses them into that one event. A
rejected `getToken`, or one that has not settled within 30s, is surfaced as an `error` event
and retried on the same schedule; any successful refresh resets the ladder. With **no** `getToken` configured there is nothing to refresh: the loader emits a
single `error` with code `token_expired` at the moment the token runs out, instead of leaving
you to discover it through failing calls.

## Module

```ts
import { mount } from '@snapnedit/embed';

const editor = await mount('#editor', {
  publishableKey: 'pk_live_...',
  theme: { mode: 'dark', accent: '#7c5cff' },
});

await editor.loadImage(blob);          // a Blob/File, or an absolute cross-origin https:/blob:/data: URL
await editor.run('remove-background');
const { blob } = await editor.export('png');
editor.on('job', (e) => console.log(e.operation, e.status, e.credits, e.cached)); // see "Metering your own end users"
editor.destroy();
```

## Export

`features.export.mode` decides where the bytes from the frame's **own** Export button go:
`'download'` saves a file, `'callback'` fires the `export` event with the blob, `'both'`
(the default inside an embed) does both from a single render. **Every** menu item is
delivered in `'callback'` mode — including the multi-page **PDF · all pages** item (real
PDF bytes, `format: 'pdf'`) and the animated **GIF** item (`format: 'gif'`, an `image/gif`
blob at the GIF's own dimensions). Nothing is hidden just because the mode is `'callback'`.

Since `'gif'` is not a value `features.export.formats` accepts, setting `formats` at all is
read as an exact list and hides the GIF item; leave `formats` unset to keep it.

The **programmatic** `handle.export(format, opts?)` runs the same builders as that menu, so
neither path is a lesser version of the other: `'pdf'` is a real `application/pdf` whose
single page is `doc.width × doc.height`, and `'svg'` a true vector document. `width`/`height`
report the **document's** dimensions for `pdf`/`svg` (`scale`/`targetWidth` raise the DPI of
the raster embedded in a PDF page, never the page itself) and the rendered bitmap's for the
raster formats.

`opts.allPages` is **`pdf`-only**: it returns one PDF containing every page of the project
(one PDF page per project page, each sized to its own document) — the programmatic twin of
the **PDF · all pages** item, with `width`/`height` reporting the *active* page since pages
may differ in size. It is ignored, not rejected, for every other format, and leaving it out
means `false`.

`'gif'` is not a value `handle.export()` accepts at all — it is `export`-event-only, which is
why `features.export.formats` is typed `AllowlistExportFormat[]` (`ExportFormat` minus
`'gif'`).

## Save straight to your storage

`handle.exportTo(target, opts?)` renders exactly what `export()` renders and then
**uploads the bytes from the editor frame itself** to a presigned URL you supply. Your
server never sees the file and the browser uploads once, instead of handing the blob to
your page to re-send.

```ts
const { status, bytes, etag } = await editor.exportTo(
  { url: presignedUrl, format: 'png', headers: { 'x-amz-acl': 'private' } },
  { scale: 2 },
);
```

`opts` is the same `EmbedExportOptions` `export()` takes (`scale`, `targetWidth`,
`quality`, `allPages`), and `target.format` the same format union — defaulting to `'png'`.
It resolves with `{ ok: true, status, bytes, mime, width, height, etag }` (`etag` is `null`
unless the bucket exposes it, see the CORS rules below) and rejects with an `EmbedError`:

| `code` | when |
| --- | --- |
| `invalid_input` | `url` is not an absolute `https:` URL, or is on the editor frame's own origin; a method other than `PUT`/`POST`; an unknown format; a header outside the allowlist. Nothing is rendered or sent. |
| `network_error` | the request never got a response — a CORS refusal, DNS/TLS failure, or a redirect (uploads use `redirect: 'error'`). The browser hides the reason from the page; the frame's devtools console has it. |
| `upload_failed` | the endpoint answered non-2xx. The status is in `err.details.status`. |
| `unsupported` | the `/embed` frame is older than this loader and has no `exportTo`. |

### Or: name a saved destination instead of minting a URL

If the bucket is already saved on your snapnedit account as a **storage destination**
(dashboard → Storage), pass its id and skip everything below — no presigned URL, no
signing code, nothing to configure on your page:

```ts
const destinations = await editor.listDestinations();
// → [{ id: 'dst_1', name: 'Production', provider: 'aws-s3', bucket: 'my-app-images', isDefault: true }]

const result = await editor.exportTo({ destinationId: 'dst_1', format: 'png' });
// → { ok: true, status: 200, bytes: 91234, mime: 'image/png', width: 1024, height: 768,
//      etag: '"…"', key: 'snapnedit/2026/09/13/….png', bucket: 'my-app-images' }
```

The frame asks the api for a one-shot signed slot using its own embed session, then PUTs
into it exactly as it would into a URL you minted. Two fields are added to the result that
a self-minted upload does not get — **`key`** and **`bucket`** — because you did not choose
them. `method` is not accepted on this shape (it is always a signed `PUT`), and passing both
`url` and `destinationId`, or neither, rejects with `invalid_input`.

`listDestinations()` returns only what a picker needs: no region, no endpoint, no part of a
credential. It resolves with `[]` for an account with no destinations, and rejects with the
api's own codes (`not_found`, `unauthorized`) when the session cannot read them.

**Your host page still needs no CORS configuration** — the request comes from the editor
frame. The **bucket** does still need the rule in step 2 below, allowing `PUT` from
`https://snapnedit.com`.

Full setup, provider fields and bucket permissions:
<https://snapnedit.com/docs/storage-destinations>

### 1. Mint the URL on your server

```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: 'us-east-1' });
const url = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket: 'my-bucket', Key: `users/${user.id}/design.png`, ContentType: 'image/png' }),
  { expiresIn: 300 },
);
```

Hand that `url` to the browser and pass it straight to `exportTo`. **The `ContentType` you
sign must match the format you export** (`image/png`, `image/jpeg`, `image/webp`,
`image/avif`, `image/svg+xml`, `application/pdf`) — S3 answers `403` when the signed and
sent `Content-Type` differ. `exportTo` sends the exported mime by default; pass your own
`headers['content-type']` to override it, and sign every extra header you pass.

Allowed headers (case-insensitive, at most 16): `content-type`, `cache-control`,
`content-disposition`, and the `x-amz-*` / `x-goog-*` / `x-ms-*` prefixes. Anything else
rejects with `invalid_input`. The request is always `credentials: 'omit'` — no cookies ever
ride along — and the response body is never read.

### 2. Allow the EDITOR FRAME's origin in your bucket's CORS

The upload comes from `https://snapnedit.com` (the iframe), **not from your own site's
origin** — that is the single most common reason a first attempt fails with
`network_error`. Put `ETag` in `ExposeHeaders` if you want it back in the result.

S3 (`aws s3api put-bucket-cors`):

```json
[
  {
    "AllowedOrigins": ["https://snapnedit.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "cache-control", "content-disposition", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Cloudflare R2 (same document, `allowed`/`exposeHeaders` spelling — R2 dashboard → bucket →
Settings → CORS policy):

```json
[
  {
    "allowed": {
      "origins": ["https://snapnedit.com"],
      "methods": ["PUT"],
      "headers": ["content-type", "cache-control", "content-disposition", "x-amz-*"]
    },
    "exposeHeaders": ["ETag"],
    "maxAgeSeconds": 3000
  }
]
```

Add `"POST"` to the methods if you sign POST uploads, and use your self-hosted deployment's
origin in place of `https://snapnedit.com` if you set `config.origin`.

## Metering your own end users

The `job` event is the whole billing story, so you never have to reconcile
against snapnedit's API:

```ts
editor.on('job', (e) => {
  if (e.status !== 'succeeded') return;          // started = estimate; failed = refunded
  if (e.cached || e.deliveryOnly) return;        // not billed to you, so don't bill your user
  meter(e.endUserId, e.operation, e.credits);    // what your account was actually charged
});
```

| Field | Meaning |
| --- | --- |
| `credits` | The operation's **published** cost on `started` (an estimate), and what the server actually reported on `succeeded`/`failed`. `0` for a free operation such as `resize-image`. Bill off the terminal event. |
| `cached` | The result came back from snapnedit's content-addressed cache — the same image, operation and params had already been run. Not billed. Always `false` on `started`/`failed`. |
| `deliveryOnly` | The job existed only to push an already-computed result into a storage destination; no operation ran. Also not billed. |
| `endUserId` | Whatever you minted the [host token](https://snapnedit.com/docs/embed#host-minted-tokens) with — your attribution key. |
| `jobId` / `durationMs` / `error` | The job's id, its wall-clock time, and the typed failure code when `status` is `'failed'`. |

Your account's own totals — jobs, credits, cache hits and embed sessions,
broken down by key, origin and operation — live in the dashboard and at
`GET /usage`: <https://snapnedit.com/docs/usage>.

## React

```tsx
import { SnapneditEditor } from '@snapnedit/embed/react';

<SnapneditEditor config={{ publishableKey: 'pk_live_...' }} onSave={(e) => save(e.document)} />;
```

Full reference — config, `EditorHandle`, events, theming, keys and limits:
<https://snapnedit.com/docs/embed>.

## Native apps

The same editor runs inside a WKWebView, WebView2, Android WebView or Flutter
webview. There is no parent window to `postMessage` to, so the frame installs
`window.SnapneditNativeBridge` and speaks the identical protocol over your
shell's JavaScript bridge:

```
https://snapnedit.com/embed?transport=native&origin=native:com.acme.photos&key=pk_live_...
```

Add `native:com.acme.photos` to the key's allowed origins in the dashboard,
send messages in with `SnapneditNativeBridge.receive(json)`, and receive them
on your platform's channel (`webkit.messageHandlers.snapnedit`,
`chrome.webview`, `SnapneditAndroid`, `flutter_inappwebview`, or a
`Snapnedit` JavaScript channel).

Guide: <https://snapnedit.com/docs/embed-native>. The wire contract is
machine-readable in [`protocol.json`](./protocol.json), shipped with this
package — every message, method, event and error code, for wrapper authors.
Official Swift/.NET/Kotlin/Dart wrappers are in progress under
[github.com/Snap-N-Edit](https://github.com/Snap-N-Edit).

## Development

This package is developed inside the private snapnedit monorepo and mirrored to
[github.com/Snap-N-Edit/embed](https://github.com/Snap-N-Edit/embed)
with its history. The mirror is read-only for code (it references sibling
workspace packages, so it does not build on its own) — file issues and
feature requests there, and pull requests are welcome as proposals; the change
lands through the monorepo and the mirror is refreshed on every release.

Licensed under the [MIT License](./LICENSE).
