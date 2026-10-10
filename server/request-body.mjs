export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Count streamed bytes, not JavaScript characters or an untrusted Content-Length.
export async function readBoundedText(input, maximumBytes) {
  const declared = input.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request exceeds the size limit.");
  }
  if (!input.body) return "";
  const reader = input.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, "BODY_TOO_LARGE", "The request exceeds the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_BODY", "The request body could not be read.");
  } finally { reader.releaseLock(); }
}

export async function readJsonRequest(request, maximumBytes = 1024 * 1024) {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(request.headers.get("content-type") || "")) {
    throw new ApiError(415, "JSON_REQUIRED", "Send the request as application/json.");
  }
  try { return JSON.parse(await readBoundedText(request, maximumBytes)); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "The request body must contain valid JSON.");
  }
}

export function checkSameOrigin(request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== null && origin !== new URL(request.url).origin
    || fetchSite !== null && !["same-origin", "none"].includes(fetchSite)) {
    throw new ApiError(403, "CROSS_ORIGIN", "Save changes from this app's own page.");
  }
}
