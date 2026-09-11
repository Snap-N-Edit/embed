# @snapnedit/embed

Loads the full [snapnedit](https://snapnedit.com) editor into your page as a sandboxed
iframe and gives you a typed handle to drive it. Browser-only, zero runtime dependencies;
React is an optional peer.

> **Not yet published to npm.** Use the script tag below today — it is served from
> `https://snapnedit.com/embed/v1.js`. The module API documented here is what the package
> will expose when it ships.

## Script tag

```html
<div id="editor" style="height: 640px"></div>
<script src="https://snapnedit.com/embed/v1.js" data-key="pk_live_..." data-target="#editor"></script>
```

Auto-mounts into `data-target`. `data-token`, `data-locale` and `data-config` (a JSON
`EmbedConfig`) are also read. Without `data-key`/`data-token`, call `window.Snapnedit.mount()`
yourself.

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

## React

```tsx
import { SnapneditEditor } from '@snapnedit/embed/react';

<SnapneditEditor config={{ publishableKey: 'pk_live_...' }} onSave={(e) => save(e.document)} />;
```

Full reference — config, `EditorHandle`, events, theming, keys and limits:
<https://snapnedit.com/docs/embed>.
