// Public action link tokens in Broadcast's format (Plugins::PublicActionLink: an
// ActiveSupport::MessageVerifier with url_safe: true and the JSON serializer): base64url of the JSON
// fields without padding, "--", and the HMAC-SHA1 of that text in hex. spec/plugin-api-1-vectors.json
// publicActionTokens holds tokens Broadcast made; both sides test against them.
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const plain = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(plain, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacHex(key: Uint8Array, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeToken(key: Uint8Array, fields: unknown[]): Promise<string> {
  const data = base64url(encoder.encode(JSON.stringify(fields)));
  return `${data}--${await hmacHex(key, data)}`;
}

// The fields of a valid token, or null
export async function readToken(key: Uint8Array, token: string): Promise<unknown[] | null> {
  const at = token.lastIndexOf("--");
  if (at <= 0) return null;
  const data = token.slice(0, at);
  const given = token.slice(at + 2);
  const expected = await hmacHex(key, data);
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  const bytes = fromBase64url(data);
  if (!bytes) return null;
  try {
    const fields = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(fields) && fields.length === 4 ? fields : null;
  } catch {
    return null;
  }
}
