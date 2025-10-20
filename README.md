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

## API Reference

### `fetchImpersonated(input, init)`

High-level Fetch-compatible API for making impersonated requests.

**Parameters:**

- `input: string | URL | Request` - The URL or Request object
- `init: ImpersonatedFetchInit` - Request configuration (extends standard RequestInit)
  - `target: string` - **Required.** Browser profile to impersonate (e.g., "chrome124", "firefox109", "safari16")
  - `defaultHeaders?: boolean` - Include curl-impersonate's default headers (default: true)
  - `timeoutMs?: number` - Request timeout in milliseconds
  - `insecureSkipVerify?: boolean` - Disable TLS verification (not recommended)
  - `responseType?: "buffer" | "stream"` - Response body handling (default: "stream")
  - `maxResponseSize?: number` - Maximum response body size in bytes (default: 100MB for buffered mode, unlimited for streaming mode)
  - Plus all standard `RequestInit` options (method, headers, body, signal, redirect, etc.)

**Returns:** `Promise<Response>` - Standard Fetch API Response object

**Example:**

```ts
const response = await fetchImpersonated("https://api.example.com/data", {
  target: "chrome124",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ key: "value" }),
  redirect: "follow",
  signal: AbortSignal.timeout(5000),
  maxResponseSize: 10 * 1024 * 1024, // 10MB limit
});

const data = await response.json();
```

### `impersonatedRequest(options, loadOptions?)`

Low-level API for direct control over request configuration.

**Parameters:**

- `options: ImpersonatedRequestOptions`
  - `url: string` - Target URL (must be http:// or https://)
  - `target: string` - Browser profile to impersonate
  - `method?: string` - HTTP method (default: "GET")
  - `headers?: HeadersInit` - Custom headers
  - `headerList?: string[]` - Pre-formatted header lines
  - `body?: BodyInit | null` - Request body
  - `defaultHeaders?: boolean` - Include default headers (default: true)
  - `timeoutMs?: number` - Request timeout
  - `followRedirects?: boolean` - Follow HTTP redirects
  - `insecureSkipVerify?: boolean` - Disable TLS verification
  - `abortSignal?: AbortSignal` - Abort signal for cancellation
  - `responseType?: "buffer" | "stream"` - Response body mode
  - `maxResponseSize?: number` - Maximum response size (default: 100MB for buffered, unlimited for streaming)
- `loadOptions?: LoadCurlImpersonateOptions` - Library loading options
  - `searchPaths?: string[]` - Custom library search paths
  - `skipGlobalInit?: boolean` - Skip curl_global_init() call

**Returns:** `Promise<ImpersonatedResponse>`

```ts
interface ImpersonatedResponse {
  statusCode: number;
  headers: string[]; // Raw header lines
  body: Uint8Array; // Response body (empty if responseType is "stream")
  bodyStream?: ReadableStream<Uint8Array>; // Present if responseType is "stream"
  effectiveUrl: string; // Final URL after redirects
}
```

### `loadCurlImpersonate(options?)`

Manually load and initialize the curl-impersonate library. Usually not needed as it's called automatically.

### `unloadCurlLibrary()`

Clean up and unload the curl-impersonate library. Call this when shutting down to free resources.

## Troubleshooting

### Library not found

**Error:** `Unable to locate libcurl-impersonate shared library`

**Solutions:**

1. Set the `CURL_IMPERSONATE_PATH` environment variable:

   ```bash
   export CURL_IMPERSONATE_PATH=/path/to/libcurl-impersonate-chrome.dylib
   ```

2. Install curl-impersonate in a standard location:

   ```bash
   # macOS (Homebrew)
   brew install curl-impersonate

   # Manual installation
   tar -xzf libcurl-impersonate-chrome-<platform>.tar.gz -C ~/.local/lib
   ```

3. Pass custom search paths:
   ```ts
   loadCurlImpersonate({
     searchPaths: ["/custom/path/to/lib"],
   });
   ```

### URL scheme validation errors

**Error:** `Invalid URL scheme "file:". Only http:// and https:// are allowed.`

**Cause:** For security, only HTTP and HTTPS URLs are permitted.

**Solution:** Ensure your URLs start with `http://` or `https://`.

### Response too large

**Error:** Request fails or returns incomplete data when using buffered mode

**Cause:** Response exceeds the default 100MB size limit for buffered responses (`responseType: "buffer"`).

**Solutions:**

1. Use streaming mode (recommended for large responses):

   ```ts
   const response = await fetchImpersonated(url, {
     target: "chrome124",
     responseType: "stream", // unlimited by default
   });

   // Process stream in chunks
   for await (const chunk of response.body) {
     // Handle each chunk
   }
   ```

2. Increase the limit for buffered mode:
   ```ts
   await fetchImpersonated(url, {
     target: "chrome124",
     responseType: "buffer",
     maxResponseSize: 500 * 1024 * 1024, // 500MB
   });
   ```

**Note:** Streaming mode has no default size limit because chunks are forwarded immediately without accumulating in memory.

### Timeout errors

**Error:** `The operation timed out after Xms`

**Solution:** Increase the timeout or use AbortSignal:

```ts
await fetchImpersonated(url, {
  target: "chrome124",
  timeoutMs: 30000, // 30 seconds
});

// Or use AbortSignal for more control
await fetchImpersonated(url, {
  target: "chrome124",
  signal: AbortSignal.timeout(30000),
});
```

### CRLF injection blocked

**Error:** `HTTP header values must not contain CR (\r) or LF (\n) characters`

**Cause:** Security protection against header injection attacks.

**Solution:** Ensure header values don't contain newline characters. This is usually a bug in your code.

### Performance issues with concurrent requests

**Issue:** Many concurrent requests fail or hang

**Solutions:**

1. Limit concurrency:

   ```ts
   const limit = 5;
   const chunks = [];
   for (let i = 0; i < urls.length; i += limit) {
     chunks.push(urls.slice(i, i + limit));
   }

   for (const chunk of chunks) {
     await Promise.all(
       chunk.map((url) => fetchImpersonated(url, { target: "chrome124" })),
     );
   }
   ```

2. Increase timeouts for concurrent workloads
3. Consider using connection pooling (not yet implemented)

## Security Considerations

- **URL Validation:** Only `http://` and `https://` schemes are allowed to prevent local file access and other protocol exploits.
- **Header Injection Protection:** CRLF characters in headers are blocked to prevent HTTP response splitting attacks.
- **TLS Verification:** By default, TLS certificates are verified. Only disable with `insecureSkipVerify` for testing.
- **Response Size Limits:** Default 100MB limit for buffered mode (`responseType: "buffer"`) prevents memory exhaustion. Streaming mode (`responseType: "stream"`) has no default limit as chunks are forwarded immediately without accumulating in memory.

## License

MIT

## Contributing

Contributions are welcome! Please ensure:

- All tests pass (`bun run test:all`)
- Code is formatted (`bun run format:write`)
- TypeScript checks pass (`bun run typecheck`)
- Follow Conventional Commits for commit messages
