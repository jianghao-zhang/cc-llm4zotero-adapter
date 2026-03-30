import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent } from "../types.js";

export interface TraceEventRecord {
  runId: string;
  conversationKey: string;
  event: AgentEvent;
}

export interface TraceStore {
  append(record: TraceEventRecord): Promise<void>;
  list(conversationKey: string): Promise<TraceEventRecord[]>;
  clear(conversationKey: string): Promise<void>;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly records: TraceEventRecord[] = [];

  async append(record: TraceEventRecord): Promise<void> {
    this.records.push(record);
  }

  async list(conversationKey: string): Promise<TraceEventRecord[]> {
    return this.records.filter((r) => r.conversationKey === conversationKey);
  }

  async clear(conversationKey: string): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i].conversationKey === conversationKey) {
        this.records.splice(i, 1);
      }
    }
  }
}

export class JsonFileTraceStore implements TraceStore {
  constructor(private readonly filePath: string) {}

  async append(record: TraceEventRecord): Promise<void> {
    const all = await this.readState();
    all.push(record);
    await this.writeState(all);
  }

  async list(conversationKey: string): Promise<TraceEventRecord[]> {
    const all = await this.readState();
    return all.filter((r) => r.conversationKey === conversationKey);
  }

  async clear(conversationKey: string): Promise<void> {
    const all = await this.readState();
    const next = all.filter((r) => r.conversationKey !== conversationKey);
    await this.writeState(next);
  }

  private async readState(): Promise<TraceEventRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TraceEventRecord[];
      return parsed;
    } catch {
      return [];
    }
  }

  private async writeState(state: TraceEventRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
