# bunpersonate Bun FFI bindings

This package provides a thin-but-friendly wrapper around [curl-impersonate](https://github.com/lexiforest/curl-impersonate)'s `libcurl` build using Bun's [`bun:ffi`](https://bun.sh/docs/api/ffi) APIs.

## Prerequisites

Install the `curl-impersonate` shared libraries (`libcurl-impersonate-chrome` and/or `libcurl-impersonate-firefox`) on your system. The lexiforest distributions ship tarballs named `libcurl-impersonate-<browser>-<platform>.tar.*` that contain the `.so`/`.dylib` files. Extract those somewhere on disk (for example `~/.local/lib`) and either:

- set `CURL_IMPERSONATE_PATH` to the directory or specific library file, or
- pass a `searchPaths` array when calling `loadCurlImpersonate`, or
- rely on the built-in search which scans common prefixes (`/usr/lib`, `/usr/local/lib`, Homebrew Cellar, relative to any `curl-impersonate` binaries on `$PATH`, etc).

> The CLI-only bundle that drops executables into `~/.local/bin` does **not** include the shared libraries required for FFI. Make sure you install the matching `lib/` artifacts from the release archive.

## Installation

```bash
bun install
```

## Quick start (Fetch-compatible API)

```ts
import { fetchImpersonated } from "./index.ts";

const response = await fetchImpersonated("https://www.example.com", {
  target: "chrome124", // any curl-impersonate target string
  headers: {
    "Accept-Language": "en-US,en;q=0.9",
  },
  redirect: "follow",
  timeoutMs: 10_000,
});

console.log(response.status, response.redirected, response.url);
console.log(await response.text());
```

`fetchImpersonated` mirrors the WHATWG Fetch API: it accepts any `RequestInfo` + `RequestInit`, honors `redirect`, `signal`, and standard body types, and returns a real `Response` with `Headers` support. The only required extension is `init.target`, which selects the curl-impersonate browser profile.

### Streaming responses & uploads

- `fetchImpersonated` streams response bodies by default. Opt into buffering by setting `responseType: "buffer"` if you need the legacy behavior.
- The low-level `impersonatedRequest` API accepts the full `BodyInit` union (strings, `Blob`, `URLSearchParams`, `FormData`, typed arrays, and `ReadableStream`). Appropriate `Content-Type` headers are inferred when possible—override them via `headers` or `headerList` as needed.
- For cancellation, prefer `AbortSignal.timeout()` or a shared `AbortController`—`timeoutMs` now cooperates with signals and is implemented as a convenience wrapper.

## Low-level helper

`impersonatedRequest` remains available when you want direct access to the raw buffers or need to integrate with the underlying FFI primitives.

```ts
import {
  loadCurlImpersonate,
  impersonatedRequest,
  unloadCurlLibrary,
} from "./index.ts";

// Preload with a custom path and skip global init when managed externally
loadCurlImpersonate({
  searchPaths: ["/custom/lib/libcurl-impersonate-chrome.dylib"],
});

try {
  const { body } = await impersonatedRequest({
    url: "https://api.example.com",
    target: "chrome120",
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
    headers: {
      "Content-Type": "application/json",
    },
  });
  console.log(JSON.parse(new TextDecoder().decode(body)));
} finally {
  unloadCurlLibrary();
}
```

- The response payload defaults to a buffered `Uint8Array`. Set `responseType: "stream"` to receive a `ReadableStream<Uint8Array>` via the `bodyStream` property alongside the buffered view.
- Headers can be provided as `HeadersInit` or preformatted strings. When a `BodyInit` implies a `Content-Type`, it is appended automatically unless you override it.

## Tests

```bash
bun test
```

The default test suite exercises library loading and the fetch-style helpers in the Bun test runner using lightweight unit tests. To run everything, including the end-to-end smoke check, use:

```bash
bun run test:all
```

That command runs `bun test` followed by the smoke script (which covers both `impersonatedRequest` and `fetchImpersonated`). The smoke test remains in a separate process because Bun's test workers may still crash on network-heavy FFI calls.
