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

await editor.loadImage(blob);          // https:, blob: or data: URLs, or a Blob/File
await editor.run('remove-background');
const { blob } = await editor.export('png');
editor.on('job', (e) => console.log(e.operation, e.status));
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

The one asymmetry: the **programmatic** `handle.export('pdf')` resolves with a rendered
**PNG** raster, not a PDF container (the frame does not carry the PDF library). The in-UI
`pdf` item does produce real PDF bytes on both paths. `'gif'` is not a value
`handle.export()` accepts at all — it is `export`-event-only, which is why
`features.export.formats` is typed `AllowlistExportFormat[]` (`ExportFormat` minus `'gif'`).

## React

```tsx
import { SnapneditEditor } from '@snapnedit/embed/react';

<SnapneditEditor config={{ publishableKey: 'pk_live_...' }} onSave={(e) => save(e.document)} />;
```

Full reference — config, `EditorHandle`, events, theming, keys and limits:
<https://snapnedit.com/docs/embed>.
