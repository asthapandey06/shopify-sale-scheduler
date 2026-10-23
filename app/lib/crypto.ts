import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM encryption for secrets stored in the database (Shopify access and
 * refresh tokens).
 *
 * Stored format:  enc:v1:<keyId>:<iv>:<authTag>:<ciphertext>   (base64url parts)
 *
 * - A fresh random 96-bit IV per value.
 * - The GCM auth tag rejects any tampered ciphertext.
 * - Associated data (the session id) binds a ciphertext to its row, so a token
 *   copied into another row fails to decrypt.
 * - Key ids allow rotation: encrypt with the active key, decrypt with any key
 *   still in the keyring.
 */

const PREFIX = "enc:v1:";
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

export interface TokenCipher {
  encrypt(plaintext: string, aad: string): string;
  decrypt(value: string, aad: string): string;
  isEncrypted(value: string): boolean;
  /** True when the value was encrypted with a key other than the active one. */
  needsRotation(value: string): boolean;
}

export interface Keyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

/**
 * Parses TOKEN_ENCRYPTION_KEYS: comma-separated "<id>:<base64 32-byte key>".
 * The first entry is the active key; later entries are kept for decrypting
 * values written before a rotation.
 */
export function parseKeyring(raw: string | undefined): Keyring {
  if (!raw || !raw.trim()) {
    throw new Error("TOKEN_ENCRYPTION_KEYS is not set");
  }
  const keys = new Map<string, Buffer>();
  let activeKeyId = "";
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("TOKEN_ENCRYPTION_KEYS entries must look like id:base64key");
    const id = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (!KEY_ID_RE.test(id)) throw new Error(`Invalid encryption key id "${id}"`);
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (base64-encoded)`);
    if (keys.has(id)) throw new Error(`Duplicate encryption key id "${id}"`);
    keys.set(id, key);
    if (!activeKeyId) activeKeyId = id;
  }
  if (!activeKeyId) throw new Error("TOKEN_ENCRYPTION_KEYS has no keys");
  return { activeKeyId, keys };
}

export function createTokenCipher(keyring: Keyring): TokenCipher {
  const activeKey = keyring.keys.get(keyring.activeKeyId);
  if (!activeKey) throw new Error("Active encryption key missing from keyring");

  return {
    isEncrypted(value) {
      return value.startsWith(PREFIX);
    },

    needsRotation(value) {
      if (!value.startsWith(PREFIX)) return true;
      return value.slice(PREFIX.length).split(":")[0] !== keyring.activeKeyId;
    },

    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return (
        PREFIX +
        [keyring.activeKeyId, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":")
      );
    },

    decrypt(value, aad) {
      // Rows written before encryption was enabled are returned unchanged and
      // get encrypted the next time the library stores the session.
      if (!value.startsWith(PREFIX)) return value;
      const parts = value.slice(PREFIX.length).split(":");
      if (parts.length !== 4) throw new Error("Malformed encrypted value");
      const [keyId, ivB64, tagB64, dataB64] = parts;
      const key = keyring.keys.get(keyId);
      if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
      const iv = Buffer.from(ivB64, "base64url");
      const tag = Buffer.from(tagB64, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted value");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Fields of a Shopify session that hold secrets. */
export interface TokenFields {
  id: string;
  accessToken?: string;
  refreshToken?: string;
}

export function encryptTokenFields<T extends TokenFields>(session: T, cipher: TokenCipher): T {
  return {
    ...session,
    accessToken: session.accessToken ? cipher.encrypt(session.accessToken, `${session.id}:access`) : session.accessToken,
    refreshToken: session.refreshToken ? cipher.encrypt(session.refreshToken, `${session.id}:refresh`) : session.refreshToken,
  };
}

export function decryptTokenFields<T extends TokenFields>(session: T, cipher: TokenCipher): T {
  return {
    ...session,
    accessToken: session.accessToken ? cipher.decrypt(session.accessToken, `${session.id}:access`) : session.accessToken,
    refreshToken: session.refreshToken ? cipher.decrypt(session.refreshToken, `${session.id}:refresh`) : session.refreshToken,
  };
}
