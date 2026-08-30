/**
 * Secret storage boundary. Implementations must never log or return a secret
 * to status/preview paths. The only supported secret is an LLM API key.
 */
export interface CredentialStore {
  get(target: string): Promise<string | undefined>;
  has(target: string): Promise<boolean>;
  set(target: string, secret: string): Promise<void>;
  delete(target: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, string>();

  async get(target: string): Promise<string | undefined> {
    return this.#values.get(target);
  }

  async has(target: string): Promise<boolean> {
    return this.#values.has(target);
  }

  async set(target: string, secret: string): Promise<void> {
    if (target.length === 0) throw new Error("Credential target must not be empty");
    if (secret.length === 0) throw new Error("Credential secret must not be empty");
    this.#values.set(target, secret);
  }

  async delete(target: string): Promise<void> {
    this.#values.delete(target);
  }
}
