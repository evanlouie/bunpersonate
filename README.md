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

## Quick start

```ts
import { impersonatedRequest } from "./index.ts";

const response = await impersonatedRequest({
  url: "https://www.example.com",
  target: "chrome124", // any curl-impersonate target string
  headers: {
    "Accept-Language": "en-US,en;q=0.9",
  },
  followRedirects: true,
  timeoutMs: 10_000,
});

console.log(response.statusCode);
console.log(new TextDecoder().decode(response.body));
```

`impersonatedRequest` automatically:

- Loads the `libcurl-impersonate-*.{so,dylib}` shared library.
- Calls `curl_global_init()` once per process.
- Applies the impersonation profile using `curl_easy_impersonate()`.
- Collects the response body and headers into Bun-friendly data structures.

### Advanced usage

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

## Tests

```bash
bun test
```

The default test suite exercises library loading in the Bun test runner. For an end-to-end real HTTP check, run the standalone smoke test (kept separate because Bun's test workers currently abort when performing networked FFI calls):

```bash
bun run test/smoke.ts
```
