import {
  dlopen,
  CString,
  JSCallback,
  cc,
  ptr,
  toArrayBuffer,
  type Pointer,
  type Library,
} from "bun:ffi";
import { basename, dirname, join } from "path";

/**
 * Names of impersonation profiles bundled with curl-impersonate.
 * You can also provide custom targets compiled into your local build.
 */
export type CurlBrowserTarget =
  | "chrome99"
  | "chrome100"
  | "chrome101"
  | "chrome104"
  | "chrome107"
  | "chrome110"
  | "chrome116"
  | "chrome119"
  | "chrome120"
  | "chrome123"
  | "chrome124"
  | "edge101"
  | "edge120"
  | "firefox99"
  | "firefox102"
  | "firefox109"
  | "safari16"
  | string;

/**
 * Options that control how the libcurl-impersonate shared library is located and initialized.
 */
export interface LoadCurlImpersonateOptions {
  /**
   * Provide explicit search paths (absolute or relative) for the shared library.
   * When omitted, a set of common installation paths is probed.
   */
  searchPaths?: string[];
  /**
   * Set to true to skip calling curl_global_init(). Useful if the application
   * performs initialization manually.
   */
  skipGlobalInit?: boolean;
}

/**
 * User-supplied options for a single impersonated HTTP request.
 */
export interface ImpersonatedRequestOptions {
  url: string;
  target: CurlBrowserTarget;
  /**
   * Include the built-in HTTP header set from curl-impersonate.
   * Defaults to true, mirroring the CLI wrappers.
   */
  defaultHeaders?: boolean;
  /**
   * Extra HTTP headers to attach (sorted as provided).
   */
  headers?: Record<string, string>;
  /**
   * Preformatted HTTP header lines. When provided, takes precedence over `headers`.
   */
  headerList?: string[];
  /**
   * HTTP method, defaults to GET. For POST/PUT/PATCH supply a body.
   */
  method?: string;
  /**
   * Request body. Treated as binary data; caller must set a matching
   * Content-Type header when needed.
   */
  body?: Uint8Array | string;
  /**
   * Abort after the given number of milliseconds.
   */
  timeoutMs?: number;
  /**
   * Follow HTTP redirects (302, 301, etc).
   */
  followRedirects?: boolean;
  /**
   * Disable TLS verification (not recommended, defaults to false).
   */
  insecureSkipVerify?: boolean;
  /**
   * Abort signal compatible with WHATWG Fetch APIs.
   */
  abortSignal?: AbortSignal | null;
}

export interface ImpersonatedFetchInit extends RequestInit {
  target: CurlBrowserTarget;
  defaultHeaders?: boolean;
  timeoutMs?: number;
  insecureSkipVerify?: boolean;
  loadOptions?: LoadCurlImpersonateOptions;
}

/**
 * Normalized response payload returned from {@link impersonatedRequest}.
 */
export interface ImpersonatedResponse {
  statusCode: number;
  headers: string[];
  body: Uint8Array;
  effectiveUrl: string;
}

type CurlCode = number;

const CURLE_BAD_FUNCTION_ARGUMENT = 43;
const CURLE_ABORTED_BY_CALLBACK = 42;

const CURL_GLOBAL_DEFAULT = 3; // curl/curl.h -> CURL_GLOBAL_SSL | CURL_GLOBAL_WIN32
const CURLINFO_RESPONSE_CODE = 0x200000 + 2;
const CURLINFO_EFFECTIVE_URL = 0x100000 + 1;
const CURL_HTTP_VERSION_2TLS = 4;
const CURLE_UNSUPPORTED_PROTOCOL = 1;

const enum CurlOption {
  WRITEDATA = 10001,
  URL = 10002,
  WRITEFUNCTION = 20011,
  HTTPHEADER = 10023,
  USERAGENT = 10018,
  FOLLOWLOCATION = 52,
  TIMEOUT_MS = 155,
  CONNECTTIMEOUT_MS = 156,
  NOPROGRESS = 43,
  ACCEPT_ENCODING = 10102,
  CUSTOMREQUEST = 10036,
  POSTFIELDS = 10015,
  POSTFIELDSIZE = 60,
  UPLOAD = 46,
  READFUNCTION = 20012,
  READDATA = 10009,
  HTTPGET = 80,
  TRANSFER_ENCODING = 207,
  HEADERFUNCTION = 20079,
  HEADERDATA = 10029,
  HTTP_VERSION = 84,
  SSL_VERIFYPEER = 64,
  SSL_VERIFYHOST = 81,
  XFERINFOFUNCTION = 20219,
  XFERINFODATA = 10057,
}

const curlLibrarySymbols = {
  curl_global_init: {
    returns: "int",
    args: ["int"],
  },
  curl_global_cleanup: {
    returns: "void",
    args: [],
  },
  curl_easy_init: {
    returns: "pointer",
    args: [],
  },
  curl_easy_cleanup: {
    returns: "void",
    args: ["pointer"],
  },
  curl_easy_perform: {
    returns: "int",
    args: ["pointer"],
  },
  curl_easy_setopt: {
    returns: "int",
    args: ["pointer", "int"],
    variadic: true,
  },
  curl_easy_getinfo: {
    returns: "int",
    args: ["pointer", "int"],
    variadic: true,
  },
  curl_easy_strerror: {
    returns: "cstring",
    args: ["int"],
  },
  curl_easy_impersonate: {
    returns: "int",
    args: ["pointer", "pointer", "int"],
  },
  curl_slist_append: {
    returns: "pointer",
    args: ["pointer", "cstring"],
  },
  curl_slist_free_all: {
    returns: "void",
    args: ["pointer"],
  },
} as const;

/**
 * Bun FFI handle for the dlopened libcurl-impersonate library.
 */
type CurlLibrary = Library<typeof curlLibrarySymbols>;

let loadedLibrary: CurlLibrary | null = null;
let globalInitDone = false;
let loadedLibraryPath: string | null = null;
let curlShim: Library<typeof shimSymbolsDefinition> | null = null;

const LIBRARY_BASENAMES = [
  "libcurl-impersonate-chrome",
  "libcurl-impersonate-firefox",
  "libcurl-impersonate",
] as const;

const LIBRARY_EXTENSIONS =
  process.platform === "darwin" ? [".dylib", ".4.dylib"] : [".so", ".so.4"];

const utf8Encoder = new TextEncoder();

function encodeCString(value: string): {
  buffer: Uint8Array;
  pointer: Pointer;
} {
  const needsNull = !value.endsWith("\0");
  const str = needsNull ? `${value}\0` : value;
  const buffer = Buffer.from(str, "utf8");
  return { buffer, pointer: ptr(buffer) };
}

const shimSymbolsDefinition = {
  curl_easy_setopt_long_shim: {
    returns: "int",
    args: ["pointer", "int", "int64_t"],
  },
  curl_easy_setopt_ptr_shim: {
    returns: "int",
    args: ["pointer", "int", "pointer"],
  },
  curl_easy_getinfo_long_shim: {
    returns: "int",
    args: ["pointer", "int", "pointer"],
  },
  curl_easy_getinfo_ptr_shim: {
    returns: "int",
    args: ["pointer", "int", "pointer"],
  },
} as const;

type CurlShimSymbols = typeof shimSymbolsDefinition;

function getCurlShimSymbols(): Library<CurlShimSymbols>["symbols"] {
  if (!curlShim) {
    if (!loadedLibraryPath) {
      throw new Error(
        "curl-impersonate library path is unknown; load the library first",
      );
    }
    const shimSource = new URL("./native/curl_shim.c", import.meta.url);
    const libDir = dirname(loadedLibraryPath);
    const libBase = basename(loadedLibraryPath)
      .replace(/^lib/, "")
      .replace(/\.(?:so(?:\.[0-9]+)?|dylib)$/i, "");
    const normalizedLib = libBase.replace(/\.[0-9]+$/, "");
    const flags: string[] = [];
    flags.push(`-L${libDir}`);
    flags.push(`-l${normalizedLib}`);
    const include = [
      join(libDir, "..", "include"),
      join(libDir, "..", "..", "include"),
      "/usr/include",
      "/usr/local/include",
      "/opt/homebrew/include",
    ];
    curlShim = cc({
      source: shimSource,
      flags,
      include,
      symbols: shimSymbolsDefinition,
    });
  }
  return curlShim.symbols;
}

function buildDefaultLibraryCandidates(): string[] {
  const baseCandidates = [
    Bun.env.CURL_IMPERSONATE_PATH,
    "/usr/lib/libcurl-impersonate-chrome.so",
    "/usr/lib/libcurl-impersonate-firefox.so",
    "/usr/local/lib/libcurl-impersonate-chrome.so",
    "/usr/local/lib/libcurl-impersonate-firefox.so",
    "/opt/homebrew/opt/curl-impersonate/lib/libcurl-impersonate-chrome.dylib",
    "/opt/homebrew/opt/curl-impersonate/lib/libcurl-impersonate-firefox.dylib",
    Bun.env.HOME ? join(Bun.env.HOME, ".local", "lib") : undefined,
    Bun.env.HOME ? join(Bun.env.HOME, ".local", "lib64") : undefined,
    Bun.env.HOME ? join(Bun.env.HOME, ".local", "bin") : undefined,
    "libcurl-impersonate-chrome",
    "libcurl-impersonate-firefox",
    "libcurl-impersonate",
    ...getBinaryRelativeCandidates(),
  ];

  return Array.from(
    new Set(
      baseCandidates
        .filter((candidate): candidate is string => Boolean(candidate))
        .flatMap(expandLibraryCandidate),
    ),
  );
}

function getBinaryRelativeCandidates(): string[] {
  const binaries = [
    "curl-impersonate",
    "curl_chrome124",
    "curl_chrome120",
    "curl_chrome99",
    "curl_firefox133",
  ];
  const dirs = new Set<string>();
  for (const name of binaries) {
    const resolved = Bun.which(name);
    if (!resolved) continue;
    const binDir = dirname(resolved);
    dirs.add(join(binDir, "..", "lib"));
    dirs.add(join(binDir, "..", "lib64"));
    dirs.add(join(binDir, ".."));
  }
  return Array.from(dirs);
}

function expandLibraryCandidate(candidate: string): string[] {
  const isBareName = !candidate.includes("/") && !candidate.includes("\\");
  if (isBareName) {
    if (/\.(so|dylib)(\.[0-9]+)?$/.test(candidate)) {
      return [candidate];
    }
    return [
      candidate,
      ...LIBRARY_EXTENSIONS.map((ext) => `${candidate}${ext}`),
      `${candidate}.dylib`,
      `${candidate}.so`,
    ];
  }
  if (/\.(so|dylib)(\.[0-9]+)?$/.test(candidate)) {
    return [candidate];
  }
  return LIBRARY_BASENAMES.flatMap((basename) =>
    LIBRARY_EXTENSIONS.map((ext) => join(candidate, basename + ext)),
  );
}

function loadLibrary(searchPaths?: string[]) {
  if (loadedLibrary) {
    return loadedLibrary;
  }

  const candidates = [
    ...(searchPaths ?? []).flatMap(expandLibraryCandidate),
    ...buildDefaultLibraryCandidates(),
  ];

  const errors: Error[] = [];

  for (const candidate of candidates) {
    try {
      loadedLibrary = dlopen(candidate, curlLibrarySymbols);
      loadedLibraryPath =
        typeof candidate === "string" ? candidate : String(candidate);
      return loadedLibrary;
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error);
      }
    }
  }

  throw new AggregateError(
    errors,
    "Unable to locate libcurl-impersonate shared library. Set CURL_IMPERSONATE_PATH, pass searchPaths, or install the libcurl-impersonate tarball from the lexiforest release.",
  );
}

function ensureInitialized(skipGlobalInit?: boolean) {
  if (globalInitDone || skipGlobalInit) {
    return;
  }
  const lib = loadedLibrary ?? loadLibrary();
  const code = lib.symbols.curl_global_init(CURL_GLOBAL_DEFAULT);
  if (code !== 0) {
    throw new Error(
      `curl_global_init() failed with code ${code}. ${getCurlErrorString(code)}`,
    );
  }
  globalInitDone = true;
}

function getCurlErrorString(code: CurlCode): string {
  const lib = loadedLibrary ?? loadLibrary();
  const messagePtr = lib.symbols.curl_easy_strerror(code);
  if (!messagePtr) return `CURLE_${code}`;
  return messagePtr.toString();
}

class CurlSlist {
  #ptr: Pointer | null = null;
  #buffers: Uint8Array[] = [];
  #lib: CurlLibrary["symbols"];

  constructor(lib: CurlLibrary["symbols"]) {
    this.#lib = lib;
  }

  append(value: string) {
    const { buffer, pointer } = encodeCString(value);
    const next = this.#lib.curl_slist_append(
      this.#ptr ?? (0 as Pointer),
      pointer,
    );
    if (!next || Number(next) === 0) {
      throw new Error("curl_slist_append() failed");
    }
    this.#buffers.push(buffer);
    this.#ptr = next;
  }

  get pointer() {
    return this.#ptr;
  }

  free() {
    if (this.#ptr && Number(this.#ptr) !== 0) {
      this.#lib.curl_slist_free_all(this.#ptr);
      this.#ptr = null;
      this.#buffers.length = 0;
    }
  }
}

function setOptPointer(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  option: CurlOption,
  value: Pointer,
): CurlCode {
  const shim = getCurlShimSymbols();
  return shim.curl_easy_setopt_ptr_shim(handle, option, value);
}

function setOptLong(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  option: CurlOption,
  value: bigint,
  allowBadArgument = false,
): CurlCode {
  const shim = getCurlShimSymbols();
  const code = shim.curl_easy_setopt_long_shim(handle, option, value);
  if (
    code !== 0 &&
    allowBadArgument &&
    (code === CURLE_BAD_FUNCTION_ARGUMENT ||
      code === CURLE_UNSUPPORTED_PROTOCOL)
  ) {
    return 0;
  }
  return code;
}

function setOptString(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  option: CurlOption,
  value: string,
) {
  const { buffer, pointer } = encodeCString(value);
  const code = setOptPointer(lib, handle, option, pointer);
  if (code !== 0) {
    throw new Error(
      `curl_easy_setopt(${option}) failed with code ${code}: ${getCurlErrorString(code)}`,
    );
  }
  return buffer;
}

function setOptNumber(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  option: CurlOption,
  value: number,
  allowBadArgument = false,
) {
  const numericValue = BigInt(Math.trunc(value));
  const code = setOptLong(lib, handle, option, numericValue, allowBadArgument);
  if (code !== 0) {
    if (allowBadArgument) {
      return;
    }
    throw new Error(
      `curl_easy_setopt(${option}) failed with code ${code}: ${getCurlErrorString(code)}`,
    );
  }
}

function getInfoLong(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  info: number,
  out: Pointer,
): CurlCode {
  const shim = getCurlShimSymbols();
  return shim.curl_easy_getinfo_long_shim(handle, info, out);
}

function getInfoPointer(
  lib: CurlLibrary["symbols"],
  handle: Pointer,
  info: number,
  out: Pointer,
): CurlCode {
  const shim = getCurlShimSymbols();
  return shim.curl_easy_getinfo_ptr_shim(handle, info, out);
}

interface AbortState {
  aborted: boolean;
  reason?: unknown;
}

interface PerformContext {
  responseChunks: Uint8Array[];
  headerLines: string[];
  headerBuffer: string;
  headerDecoder: TextDecoder;
  abortState?: AbortState;
  abortCleanup?: (() => void) | null;
}

function createWriteCallback(ctx: PerformContext) {
  return new JSCallback(
    (bufferPtr: Pointer, size: number, nmemb: number, _userdata: Pointer) => {
      const byteLength = Number(size) * Number(nmemb);
      if (byteLength === 0) {
        return 0;
      }
      const chunk = new Uint8Array(toArrayBuffer(bufferPtr, 0, byteLength));
      ctx.responseChunks.push(chunk);
      return byteLength;
    },
    {
      returns: "usize",
      args: ["pointer", "usize", "usize", "pointer"],
    },
  );
}

function createHeaderCallback(ctx: PerformContext) {
  return new JSCallback(
    (bufferPtr: Pointer, size: number, nmemb: number, _userdata: Pointer) => {
      const byteLength = Number(size) * Number(nmemb);
      if (byteLength === 0) {
        return 0;
      }
      const chunk = new Uint8Array(toArrayBuffer(bufferPtr, 0, byteLength));
      ctx.headerBuffer += ctx.headerDecoder.decode(chunk, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = ctx.headerBuffer.indexOf("\r\n")) >= 0) {
        const line = ctx.headerBuffer.slice(0, newlineIndex);
        ctx.headerBuffer = ctx.headerBuffer.slice(newlineIndex + 2);
        if (line.length > 0) {
          ctx.headerLines.push(line);
        } else {
          ctx.headerLines.push("");
        }
      }

      return byteLength;
    },
    {
      returns: "usize",
      args: ["pointer", "usize", "usize", "pointer"],
    },
  );
}

function createProgressCallback(ctx: PerformContext) {
  return new JSCallback(
    (
      _client: Pointer,
      _dltotal: bigint,
      _dlnow: bigint,
      _ultotal: bigint,
      _ulnow: bigint,
    ) => {
      if (ctx.abortState?.aborted) {
        return 1;
      }
      return 0;
    },
    {
      returns: "int",
      args: ["pointer", "int64_t", "int64_t", "int64_t", "int64_t"],
    },
  );
}

/**
 * Perform an HTTP request with curl-impersonate, applying the selected browser profile
 * and wiring the response into Bun-friendly data structures.
 *
 * @param options Request configuration, including URL, target profile, and optional overrides.
 * @param loadOptions Optional overrides for library discovery and initialization.
 * @returns The status code, headers, body, and effective URL reported by libcurl.
 */
export async function impersonatedRequest(
  options: ImpersonatedRequestOptions,
  loadOptions?: LoadCurlImpersonateOptions,
): Promise<ImpersonatedResponse> {
  const libHandle = loadCurlImpersonate(loadOptions);

  const rawHandle = libHandle.symbols.curl_easy_init();
  if (!rawHandle || Number(rawHandle) === 0) {
    throw new Error("curl_easy_init() returned null");
  }
  const handle = rawHandle as Pointer;

  const ctx: PerformContext = {
    responseChunks: [],
    headerLines: [],
    headerBuffer: "",
    headerDecoder: new TextDecoder(),
    abortCleanup: null,
  };

  const writeCallback = createWriteCallback(ctx);
  const headerCallback = createHeaderCallback(ctx);

  const lifetimes: Array<JSCallback | CurlSlist | Uint8Array> = [
    writeCallback,
    headerCallback,
  ];

  try {
    const abortSignal = options.abortSignal ?? null;
    if (abortSignal) {
      const abortState: AbortState = {
        aborted: abortSignal.aborted,
        reason: abortSignal.reason,
      };
      ctx.abortState = abortState;

      if (abortState.aborted) {
        throw toAbortError(abortState.reason);
      }

      const abortListener = () => {
        abortState.aborted = true;
        abortState.reason = abortSignal.reason;
      };
      abortSignal.addEventListener("abort", abortListener);
      ctx.abortCleanup = () => {
        abortSignal.removeEventListener("abort", abortListener);
      };

      const progressCallback = createProgressCallback(ctx);
      if (!progressCallback.ptr || Number(progressCallback.ptr) === 0) {
        throw new Error("Failed to create progress callback");
      }
      lifetimes.push(progressCallback);

      setOptNumber(libHandle.symbols, handle, CurlOption.NOPROGRESS, 0);
      const progressCode = setOptPointer(
        libHandle.symbols,
        handle,
        CurlOption.XFERINFOFUNCTION,
        progressCallback.ptr,
      );
      if (progressCode !== 0) {
        throw new Error(
          `curl_easy_setopt(CURLOPT_XFERINFOFUNCTION) failed with code ${progressCode}`,
        );
      }
      const progressDataCode = setOptPointer(
        libHandle.symbols,
        handle,
        CurlOption.XFERINFODATA,
        0 as Pointer,
      );
      if (progressDataCode !== 0) {
        throw new Error(
          `curl_easy_setopt(CURLOPT_XFERINFODATA) failed with code ${progressDataCode}`,
        );
      }
    } else {
      setOptNumber(libHandle.symbols, handle, CurlOption.NOPROGRESS, 1);
    }
    const acceptEncodingBuffer = setOptString(
      libHandle.symbols,
      handle,
      CurlOption.ACCEPT_ENCODING,
      "",
    );
    lifetimes.push(acceptEncodingBuffer);

    if (options.followRedirects !== undefined) {
      setOptNumber(
        libHandle.symbols,
        handle,
        CurlOption.FOLLOWLOCATION,
        options.followRedirects ? 1 : 0,
        true,
      );
    }

    if (typeof options.timeoutMs === "number") {
      setOptNumber(
        libHandle.symbols,
        handle,
        CurlOption.TIMEOUT_MS,
        options.timeoutMs,
      );
      setOptNumber(
        libHandle.symbols,
        handle,
        CurlOption.CONNECTTIMEOUT_MS,
        options.timeoutMs,
      );
    }

    if (options.insecureSkipVerify) {
      setOptNumber(libHandle.symbols, handle, CurlOption.SSL_VERIFYPEER, 0);
      setOptNumber(libHandle.symbols, handle, CurlOption.SSL_VERIFYHOST, 0);
    }

    const defaultHeaders = options.defaultHeaders !== false ? 1 : 0;
    const initialUrlBuffer = setOptString(
      libHandle.symbols,
      handle,
      CurlOption.URL,
      options.url,
    );
    lifetimes.push(initialUrlBuffer);
    const impersonateTarget = encodeCString(options.target);
    lifetimes.push(impersonateTarget.buffer);
    const impersonateCode = libHandle.symbols.curl_easy_impersonate(
      handle,
      impersonateTarget.pointer,
      defaultHeaders,
    );
    if (impersonateCode !== 0) {
      throw new Error(
        `curl_easy_impersonate("${options.target}") failed: ${getCurlErrorString(impersonateCode)}`,
      );
    }

    const method = options.method?.toUpperCase() ?? "GET";

    if (!options.insecureSkipVerify) {
      setOptNumber(
        libHandle.symbols,
        handle,
        CurlOption.HTTP_VERSION,
        CURL_HTTP_VERSION_2TLS,
        true,
      );
    }

    if (method === "GET") {
      setOptNumber(libHandle.symbols, handle, CurlOption.HTTPGET, 1);
    } else if (method === "POST") {
      setOptNumber(libHandle.symbols, handle, CurlOption.UPLOAD, 0);
    } else if (method === "PUT" || method === "PATCH") {
      // libcurl expects UPLOAD=1 with a read callback, but we rely on POSTFIELDS for simplicity
      const customBuffer = setOptString(
        libHandle.symbols,
        handle,
        CurlOption.CUSTOMREQUEST,
        method,
      );
      lifetimes.push(customBuffer);
    } else {
      const customBuffer = setOptString(
        libHandle.symbols,
        handle,
        CurlOption.CUSTOMREQUEST,
        method,
      );
      lifetimes.push(customBuffer);
    }

    if (options.body !== undefined) {
      const bodyBytes =
        typeof options.body === "string"
          ? utf8Encoder.encode(options.body)
          : options.body;
      lifetimes.push(bodyBytes);
      const bodyPtr = ptr(bodyBytes);
      const bodyLength = bodyBytes.byteLength;

      const bodyCode = setOptPointer(
        libHandle.symbols,
        handle,
        CurlOption.POSTFIELDS,
        bodyPtr,
      );
      if (bodyCode !== 0) {
        throw new Error(
          `curl_easy_setopt(CURLOPT_POSTFIELDS) failed with code ${bodyCode}`,
        );
      }
      const sizeCode = setOptLong(
        libHandle.symbols,
        handle,
        CurlOption.POSTFIELDSIZE,
        BigInt(bodyLength),
      );
      if (sizeCode !== 0) {
        throw new Error(
          `curl_easy_setopt(CURLOPT_POSTFIELDSIZE) failed with code ${sizeCode}`,
        );
      }
    }

    const headerLines =
      options.headerList ??
      (options.headers && Object.keys(options.headers).length > 0
        ? Object.entries(options.headers).map(
            ([name, value]) => `${name}: ${value}`,
          )
        : undefined);

    if (headerLines && headerLines.length > 0) {
      const headerList = new CurlSlist(libHandle.symbols);
      for (const line of headerLines) {
        headerList.append(line);
      }
      const headerPtr = headerList.pointer;
      if (!headerPtr || Number(headerPtr) === 0) {
        throw new Error("Failed to build curl_slist for headers");
      }
      const headerCode = setOptPointer(
        libHandle.symbols,
        handle,
        CurlOption.HTTPHEADER,
        headerPtr,
      );
      if (headerCode !== 0) {
        headerList.free();
        throw new Error(
          `curl_easy_setopt(CURLOPT_HTTPHEADER) failed with code ${headerCode}`,
        );
      }
      lifetimes.push(headerList);
    }

    if (!writeCallback.ptr || Number(writeCallback.ptr) === 0) {
      throw new Error("Failed to create write callback");
    }
    const writeCode = setOptPointer(
      libHandle.symbols,
      handle,
      CurlOption.WRITEFUNCTION,
      writeCallback.ptr,
    );
    if (writeCode !== 0) {
      throw new Error(
        `curl_easy_setopt(CURLOPT_WRITEFUNCTION) failed with code ${writeCode}`,
      );
    }

    if (!headerCallback.ptr || Number(headerCallback.ptr) === 0) {
      throw new Error("Failed to create header callback");
    }
    const writeDataCode = setOptPointer(
      libHandle.symbols,
      handle,
      CurlOption.WRITEDATA,
      0 as Pointer,
    );
    if (writeDataCode !== 0) {
      throw new Error(
        `curl_easy_setopt(CURLOPT_WRITEDATA) failed with code ${writeDataCode}`,
      );
    }
    const headerDataCode = setOptPointer(
      libHandle.symbols,
      handle,
      CurlOption.HEADERDATA,
      0 as Pointer,
    );
    if (headerDataCode !== 0) {
      throw new Error(
        `curl_easy_setopt(CURLOPT_HEADERDATA) failed with code ${headerDataCode}`,
      );
    }
    const headerCode = setOptPointer(
      libHandle.symbols,
      handle,
      CurlOption.HEADERFUNCTION,
      headerCallback.ptr,
    );
    if (headerCode !== 0) {
      throw new Error(
        `curl_easy_setopt(CURLOPT_HEADERFUNCTION) failed with code ${headerCode}`,
      );
    }

    const urlBuffer = setOptString(
      libHandle.symbols,
      handle,
      CurlOption.URL,
      options.url,
    );
    lifetimes.push(urlBuffer);

    const performCode = libHandle.symbols.curl_easy_perform(handle);
    if (
      performCode === CURLE_ABORTED_BY_CALLBACK &&
      ctx.abortState?.aborted
    ) {
      throw toAbortError(ctx.abortState.reason);
    }
    if (performCode !== 0) {
      throw new Error(
        `curl_easy_perform() failed with code ${performCode}: ${getCurlErrorString(performCode)}`,
      );
    }

    // Flush any buffered decoder state in case the final header chunk didn't terminate properly.
    ctx.headerBuffer += ctx.headerDecoder.decode();

    const responseCodeArray = new BigInt64Array(1);
    const infoCode = getInfoLong(
      libHandle.symbols,
      handle,
      CURLINFO_RESPONSE_CODE,
      ptr(responseCodeArray),
    );
    if (infoCode !== 0) {
      throw new Error(
        `curl_easy_getinfo(CURLINFO_RESPONSE_CODE) failed with code ${infoCode}`,
      );
    }

    const effectiveUrlPtrArray = new BigInt64Array(1);
    const urlInfoCode = getInfoPointer(
      libHandle.symbols,
      handle,
      CURLINFO_EFFECTIVE_URL,
      ptr(effectiveUrlPtrArray),
    );
    if (urlInfoCode !== 0) {
      throw new Error(
        `curl_easy_getinfo(CURLINFO_EFFECTIVE_URL) failed with code ${urlInfoCode}`,
      );
    }

    const body: Uint8Array = concatenateChunks(ctx.responseChunks);
    const statusCode = Number(responseCodeArray[0]);
    const effectiveUrlPtr = Number(effectiveUrlPtrArray[0]);
    const effectiveUrl =
      effectiveUrlPtr > 0
        ? new CString(effectiveUrlPtr as unknown as Pointer).toString()
        : options.url;

    return {
      statusCode,
      headers: ctx.headerLines.filter((line) => line.length > 0),
      body,
      effectiveUrl,
    };
  } finally {
    libHandle.symbols.curl_easy_cleanup(handle);
    for (const lifetime of lifetimes) {
      if (lifetime instanceof CurlSlist) {
        lifetime.free();
      } else if (lifetime instanceof JSCallback) {
        lifetime.close();
      }
    }
    ctx.abortCleanup?.();
  }
}

export async function fetchImpersonated(
  input: string | URL | Request,
  init: ImpersonatedFetchInit,
): Promise<Response> {
  if (!init || !init.target) {
    throw new TypeError(
      "fetchImpersonated requires a target impersonation profile in init.target",
    );
  }

  const {
    target,
    defaultHeaders,
    timeoutMs,
    insecureSkipVerify,
    loadOptions,
    ...requestInit
  } = init;

  const request =
    input instanceof Request
      ? new Request(input, requestInit)
      : new Request(
          typeof input === "string" ? input : input.toString(),
          requestInit,
        );
  const config = await buildFetchImpersonatedConfig(request, {
    target,
    defaultHeaders,
    timeoutMs,
    insecureSkipVerify,
  });

  const responseData = await impersonatedRequest(
    config.options,
    loadOptions,
  );

  return buildFetchResponse(responseData, config, request.url);
}

interface BuildFetchConfigInput {
  target: CurlBrowserTarget;
  defaultHeaders?: boolean;
  timeoutMs?: number;
  insecureSkipVerify?: boolean;
}

interface FetchImpersonatedConfig {
  options: ImpersonatedRequestOptions;
  redirectMode: RedirectMode;
}

type RedirectMode = "follow" | "manual" | "error";

async function buildFetchImpersonatedConfig(
  request: Request,
  input: BuildFetchConfigInput,
): Promise<FetchImpersonatedConfig> {
  const redirectMode = (request.redirect ?? "follow") as RedirectMode;
  const headerLines = buildHeaderLines(request.headers);

  let bodyBytes: Uint8Array | undefined;
  if (request.body !== null) {
    const buffer = await request.arrayBuffer();
    bodyBytes = new Uint8Array(buffer);
  }

  return {
    redirectMode,
    options: {
      url: request.url,
      target: input.target,
      defaultHeaders: input.defaultHeaders,
      headerList: headerLines,
      method: request.method,
      body: bodyBytes,
      timeoutMs: input.timeoutMs,
      followRedirects: redirectMode === "follow",
      insecureSkipVerify: input.insecureSkipVerify,
      abortSignal: request.signal,
    },
  };
}

function buildFetchResponse(
  responseData: ImpersonatedResponse,
  config: FetchImpersonatedConfig,
  originalUrl: string,
): Response {
  const headers = buildHeadersFromLines(responseData.headers);
  if (
    config.redirectMode === "error" &&
    isRedirectStatus(responseData.statusCode) &&
    headers.has("location")
  ) {
    throw new TypeError("Redirect was blocked for this request.");
  }

  const redirected =
    config.redirectMode === "follow" &&
    normalizeUrl(responseData.effectiveUrl) !== normalizeUrl(originalUrl);

  const response = new Response(responseData.body, {
    status: responseData.statusCode,
    headers,
  });

  applyResponseMetadata(response, responseData.effectiveUrl, redirected);

  return response;
}

function buildHeaderLines(headers: Headers): string[] {
  const lines: string[] = [];
  headers.forEach((value, name) => {
    lines.push(`${name}: ${value}`);
  });
  return lines;
}

function buildHeadersFromLines(lines: string[]): Headers {
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0) {
      continue;
    }
    headers.append(name, value);
  }
  return headers;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function applyResponseMetadata(
  response: Response,
  url: string,
  redirected: boolean,
) {
  try {
    Object.defineProperty(response, "url", {
      value: url,
      configurable: true,
    });
  } catch {
    try {
      (response as unknown as { url: string }).url = url;
    } catch {
      // ignore if we cannot set the URL metadata
    }
  }

  try {
    Object.defineProperty(response, "redirected", {
      value: redirected,
      configurable: true,
    });
  } catch {
    try {
      (response as unknown as { redirected: boolean }).redirected = redirected;
    } catch {
      // ignore if we cannot set the redirected flag
    }
  }
}

export const __bunpersonateInternals = {
  buildHeaderLines,
  buildHeadersFromLines,
  isRedirectStatus,
  normalizeUrl,
  applyResponseMetadata,
  buildFetchImpersonatedConfig,
  buildFetchResponse,
};

function concatenateChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof DOMException !== "undefined") {
    const message =
      typeof reason === "string" && reason.length > 0
        ? reason
        : "The operation was aborted.";
    return new DOMException(message, "AbortError");
  }
  return new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The operation was aborted.",
  );
}

/**
 * Release resources associated with a previously loaded libcurl-impersonate handle.
 * This also resets the shim so future requests can reload a freshly located library.
 */
export function unloadCurlLibrary() {
  if (loadedLibrary) {
    if (globalInitDone) {
      loadedLibrary.symbols.curl_global_cleanup();
      globalInitDone = false;
    }
    loadedLibrary.close();
    loadedLibrary = null;
    loadedLibraryPath = null;
  }
  if (curlShim) {
    curlShim.close();
    curlShim = null;
  }
}

/**
 * Locate and load the libcurl-impersonate shared library, performing `curl_global_init`
 * unless explicitly skipped.
 *
 * @param options Search path overrides and initialization flags.
 * @returns A Bun FFI handle exposing the libcurl symbol table.
 */
export function loadCurlImpersonate(
  options?: LoadCurlImpersonateOptions,
): CurlLibrary {
  const lib = loadLibrary(options?.searchPaths);
  ensureInitialized(options?.skipGlobalInit);
  return lib;
}

export type { CurlLibrary };
