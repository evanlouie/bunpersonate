import {
  impersonatedRequest,
  fetchImpersonated,
  unloadCurlLibrary,
} from "../index.ts";

async function main() {
  try {
    const legacyResponse = await impersonatedRequest({
      url: "https://example.com/",
      target: "chrome124",
      followRedirects: true,
      timeoutMs: 5_000,
    });

    if (legacyResponse.statusCode !== 200) {
      throw new Error(`Expected 200 OK, got ${legacyResponse.statusCode}`);
    }
    const body = new TextDecoder().decode(legacyResponse.body);
    if (!body.includes("Example Domain")) {
      throw new Error("Response body did not contain 'Example Domain'");
    }

    const fetchResponse = await fetchImpersonated("https://example.com/", {
      target: "chrome124",
      redirect: "follow",
      timeoutMs: 5_000,
    });

    if (fetchResponse.status !== 200) {
      throw new Error(`fetchImpersonated expected 200 OK, got ${fetchResponse.status}`);
    }
    const fetchBody = await fetchResponse.text();
    if (!fetchBody.includes("Example Domain")) {
      throw new Error("fetchImpersonated response did not contain 'Example Domain'");
    }

    console.log("Smoke test passed:", {
      legacy: {
        status: legacyResponse.statusCode,
        bytes: legacyResponse.body.byteLength,
        effectiveUrl: legacyResponse.effectiveUrl,
      },
      fetch: {
        status: fetchResponse.status,
        redirected: fetchResponse.redirected,
        url: fetchResponse.url,
      },
    });
  } finally {
    unloadCurlLibrary();
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
