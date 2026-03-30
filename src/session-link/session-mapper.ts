import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type SessionMapState = Record<string, string>;

export interface SessionMapper {
  get(conversationKey: string): Promise<string | undefined>;
  set(conversationKey: string, providerSessionId: string): Promise<void>;
  delete(conversationKey: string): Promise<void>;
}

export class InMemorySessionMapper implements SessionMapper {
  private readonly map = new Map<string, string>();

  async get(conversationKey: string): Promise<string | undefined> {
    return this.map.get(conversationKey);
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    this.map.set(conversationKey, providerSessionId);
  }

  async delete(conversationKey: string): Promise<void> {
    this.map.delete(conversationKey);
  }
}

export class JsonFileSessionMapper implements SessionMapper {
  constructor(private readonly filePath: string) {}

  async get(conversationKey: string): Promise<string | undefined> {
    const state = await this.readState();
    return state[conversationKey];
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    const state = await this.readState();
    state[conversationKey] = providerSessionId;
    await this.writeState(state);
  }

  async delete(conversationKey: string): Promise<void> {
    const state = await this.readState();
    delete state[conversationKey];
    await this.writeState(state);
  }

  private async readState(): Promise<SessionMapState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionMapState;
      return parsed;
    } catch {
      return {};
    }
  }

  private async writeState(state: SessionMapState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
