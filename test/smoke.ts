import { impersonatedRequest, unloadCurlLibrary } from "../index.ts";

async function main() {
  try {
    const response = await impersonatedRequest({
      url: "https://example.com/",
      target: "chrome124",
      followRedirects: true,
      timeoutMs: 5_000,
    });

    if (response.statusCode !== 200) {
      throw new Error(`Expected 200 OK, got ${response.statusCode}`);
    }
    const body = new TextDecoder().decode(response.body);
    if (!body.includes("Example Domain")) {
      throw new Error("Response body did not contain 'Example Domain'");
    }

    console.log("Smoke test passed:", {
      status: response.statusCode,
      bytes: response.body.byteLength,
      effectiveUrl: response.effectiveUrl,
    });
  } finally {
    unloadCurlLibrary();
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
