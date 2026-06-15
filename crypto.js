/* ICED26 — remote-link encryption (public repo, no backend).
 *
 * Meet/YouTube links are stored ENCRYPTED in data/programme.js so that the
 * public repository never exposes a usable URL. A participant types a numeric
 * code in the web; the code is the key. Decryption uses AES-GCM, whose built-in
 * authentication tag means a wrong code simply fails to decrypt — we never need
 * to store the code or a hash of it anywhere.
 *
 * Threat model: the ciphertext IS public, so a short code can be brute-forced.
 * We mitigate with (a) a 6-digit code (1e6 space) and (b) a deliberately slow
 * PBKDF2 (310k iterations) so each guess costs real time. This is "keep honest
 * people out + slow down the curious", NOT military-grade secrecy. Pair it with
 * Google Meet's waiting room for real control.
 *
 * Blob format (string):  ICEDX1:<base64url( salt(16) | iv(12) | ciphertext )>
 */
(function () {
  const PREFIX = "ICEDX1:";
  const ITER = 310000;
  const SALT_LEN = 16;
  const IV_LEN = 12;

  // Web Crypto: browser = window.crypto; Node test harness = globalThis.crypto.
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;

  function b64urlEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(code, salt) {
    const enc = new TextEncoder();
    const baseKey = await subtle.importKey(
      "raw", enc.encode(String(code)), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  // True if a value looks like one of our encrypted blobs.
  function isEnc(v) {
    return typeof v === "string" && v.startsWith(PREFIX);
  }

  async function encrypt(plaintext, code) {
    if (!subtle) throw new Error("Web Crypto unavailable");
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(code, salt);
    const ct = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
    );
    const blob = new Uint8Array(salt.length + iv.length + ct.length);
    blob.set(salt, 0); blob.set(iv, salt.length); blob.set(ct, salt.length + iv.length);
    return PREFIX + b64urlEncode(blob);
  }

  // Returns the plaintext, or null if the code is wrong / blob is invalid.
  async function decrypt(blob, code) {
    if (!subtle || !isEnc(blob)) return null;
    try {
      const raw = b64urlDecode(blob.slice(PREFIX.length));
      const salt = raw.slice(0, SALT_LEN);
      const iv = raw.slice(SALT_LEN, SALT_LEN + IV_LEN);
      const ct = raw.slice(SALT_LEN + IV_LEN);
      const key = await deriveKey(code, salt);
      const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch (e) {
      return null; // wrong code → GCM tag mismatch throws → treated as failure
    }
  }

  const api = { PREFIX, isEnc, encrypt, decrypt };
  if (typeof window !== "undefined") window.ICED26Crypto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
