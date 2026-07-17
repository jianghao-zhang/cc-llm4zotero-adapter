import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  flush?(): Promise<void>;
  getStats?(): { pendingCount: number; bufferSize: number };
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

  getStats(): { pendingCount: number; bufferSize: number } {
    return { pendingCount: 0, bufferSize: this.records.length };
  }
}

/**
 * Optimized file-based trace store with:
 * - Buffer-based batching with configurable flush interval and size threshold
 * - Append-only writes to minimize I/O
 * - Async flush with backpressure handling
 * - Periodic file rotation for large files
 */
export class JsonFileTraceStore implements TraceStore {
  private buffer: TraceEventRecord[] = [];
  private flushPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyMigrated = false;
  private isFlushing = false;

  private readonly flushIntervalMs: number;
  private readonly bufferSizeThreshold: number;
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly filePath: string,
    options?: {
      flushIntervalMs?: number;
      bufferSizeThreshold?: number;
      maxFileSizeBytes?: number;
    }
  ) {
    this.flushIntervalMs = options?.flushIntervalMs ?? 500; // 500ms default
    this.bufferSizeThreshold = options?.bufferSizeThreshold ?? 100; // 100 records
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? 50 * 1024 * 1024; // 50MB
  }

  async append(record: TraceEventRecord): Promise<void> {
    this.buffer.push(record);

    // Immediate flush if buffer is full
    if (this.buffer.length >= this.bufferSizeThreshold) {
      await this.flush();
      return;
    }

    // Only schedule flush if not already scheduled
    if (!this.flushTimer && !this.isFlushing) {
      this.scheduleFlush();
    }
  }

  async list(conversationKey: string): Promise<TraceEventRecord[]> {
    await this.flush();
    const all = await this.readState();
    return all.filter((r) => r.conversationKey === conversationKey);
  }

  async clear(conversationKey: string): Promise<void> {
    // Remove from buffer
    this.buffer = this.buffer.filter((r) => r.conversationKey !== conversationKey);

    // Clear from file
    await this.flush();
    const all = await this.readState();
    const remaining = all.filter((r) => r.conversationKey !== conversationKey);
    await this.writeState(remaining);
  }

  async flush(): Promise<void> {
    // Cancel scheduled flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for any ongoing flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    // No work to do
    if (this.buffer.length === 0) {
      return;
    }

    // Start new flush
    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  getStats(): { pendingCount: number; bufferSize: number } {
    return {
      pendingCount: this.buffer.length,
      bufferSize: this.buffer.length,
    };
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async doFlush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const batch = this.buffer.splice(0, this.buffer.length);
      if (batch.length === 0) return;

      await mkdir(dirname(this.filePath), { recursive: true });
      await this.migrateLegacyFileIfNeeded();

      // Check file size and rotate if needed
      await this.rotateIfNeeded();

      // Append batch as NDJSON
      const payload = batch
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";

      await appendFile(this.filePath, payload, "utf8");
    } finally {
      this.isFlushing = false;
    }
  }

  private async migrateLegacyFileIfNeeded(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;

    try {
      const raw = await readFile(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed || !trimmed.startsWith("[")) return;

      // Legacy array format - convert to NDJSON
      const parsed = JSON.parse(trimmed) as TraceEventRecord[];
      if (!Array.isArray(parsed)) return;

      const legacyBackupPath = `${this.filePath}.legacy-array`;
      await writeFile(legacyBackupPath, raw, "utf8");
      await this.writeState(parsed);

      console.log(`[trace-store] Migrated legacy array format to NDJSON`);
    } catch {
      this.legacyMigrated = false;
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(this.filePath));
      if (stat.size >= this.maxFileSizeBytes) {
        const rotatedPath = `${this.filePath}.${Date.now()}.rotated`;
        await rename(this.filePath, rotatedPath);
        console.log(`[trace-store] Rotated trace file to ${rotatedPath}`);
      }
    } catch {
      // File doesn't exist, no rotation needed
    }
  }

  private async readState(): Promise<TraceEventRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return [];

      // Support both formats
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed) as TraceEventRecord[];
        return Array.isArray(parsed) ? parsed : [];
      }

      // NDJSON format
      return trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceEventRecord);
    } catch {
      return [];
    }
  }

  private async writeState(state: TraceEventRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = state.length
      ? state.map((record) => JSON.stringify(record)).join("\n") + "\n"
      : "";

    try {
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // ignore
      }
      throw error;
    }
  }
}