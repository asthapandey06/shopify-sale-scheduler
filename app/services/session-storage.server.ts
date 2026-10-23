import type { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { decryptTokenFields, encryptTokenFields, type TokenCipher } from "../lib/crypto";
import { logger } from "../lib/logger";

/**
 * Session storage that encrypts access and refresh tokens before they reach the
 * database and decrypts them on the way out. A database leak or backup leak
 * alone does not expose working Shopify credentials.
 */
export class EncryptedSessionStorage {
  private readonly inner: PrismaSessionStorage<PrismaClient>;
  private readonly cipher: TokenCipher;

  constructor(prisma: PrismaClient, cipher: TokenCipher) {
    this.inner = new PrismaSessionStorage(prisma);
    this.cipher = cipher;
  }

  private seal(session: Session): Session {
    return new Session(encryptTokenFields(session.toObject(), this.cipher));
  }

  private open(session: Session | undefined): Session | undefined {
    if (!session) return undefined;
    try {
      return new Session(decryptTokenFields(session.toObject(), this.cipher));
    } catch (error) {
      // Undecryptable (unknown key / tampered): treat as missing so the shop re-authenticates.
      logger.error("Could not decrypt stored session; forcing re-authentication", {
        shop: session.shop,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  async storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(this.seal(session));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return this.open(await this.inner.loadSession(id));
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map((s) => this.open(s)).filter((s): s is Session => s !== undefined);
  }
}
