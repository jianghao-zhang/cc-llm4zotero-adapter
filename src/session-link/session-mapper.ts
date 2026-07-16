import { mkdir, readFile, writeFile, appendFile, rename, unlink } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { existsSync } from "node:fs";

type SessionMapState = Record<string, string>;

export interface SessionMapper {
  get(conversationKey: string): Promise<string | undefined>;
  getByPrefix(prefix: string): Promise<string | undefined>;
  set(conversationKey: string, providerSessionId: string): Promise<void>;
  delete(conversationKey: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

export class InMemorySessionMapper implements SessionMapper {
  private readonly map = new Map<string, string>();

  async get(conversationKey: string): Promise<string | undefined> {
    return this.map.get(conversationKey);
  }

  async getByPrefix(prefix: string): Promise<string | undefined> {
    for (const [key, value] of this.map.entries()) {
      if (key.startsWith(prefix)) return value;
    }
    return undefined;
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    this.map.set(conversationKey, providerSessionId);
  }

  async delete(conversationKey: string): Promise<void> {
    this.map.delete(conversationKey);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }
}

interface PendingWrite {
  key: string;
  value?: string; // undefined means delete
}

/**
 * Optimized file-based session mapper with:
 * - In-memory cache for fast reads
 * - Batched writes with configurable flush interval
 * - Append-only log for writes with periodic compaction
 * - Sorted keys for efficient prefix queries
 */
export class JsonFileSessionMapper implements SessionMapper {
  private readonly cache = new Map<string, string>();
  private readonly sortedKeys: string[] = [];
  private pendingWrites: PendingWrite[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionCounter = 0;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly flushIntervalMs: number;
  private readonly compactionThreshold: number;

  constructor(
    private readonly filePath: string,
    options?: { flushIntervalMs?: number; compactionThreshold?: number }
  ) {
    this.flushIntervalMs = options?.flushIntervalMs ?? 100; // 100ms batch window
    this.compactionThreshold = options?.compactionThreshold ?? 50; // compact after 50 writes
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.loadFromFile();
    await this.initPromise;
    this.initialized = true;
    this.initPromise = null;
  }

  private async loadFromFile(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return;

      // Support both JSON array format and NDJSON format
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        let entry: { key?: string; value?: string } | null = null;
        try {
          // Try parsing as NDJSON entry
          if (trimmedLine.startsWith("{")) {
            entry = JSON.parse(trimmedLine);
          }
        } catch {
          // Skip malformed lines
          continue;
        }

        if (entry && typeof entry.key === "string") {
          if (entry.value !== undefined) {
            this.cache.set(entry.key, entry.value);
          } else {
            this.cache.delete(entry.key);
          }
        }
      }

      // Rebuild sorted keys
      this.rebuildSortedKeys();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private rebuildSortedKeys(): void {
    this.sortedKeys.length = 0;
    this.sortedKeys.push(...Array.from(this.cache.keys()).sort());
  }

  private insertSortedKey(key: string): void {
    const index = this.binarySearch(key);
    if (index < 0 || this.sortedKeys[index] !== key) {
      this.sortedKeys.splice(index < 0 ? -(index + 1) : index, 0, key);
    }
  }

  private removeSortedKey(key: string): void {
    const index = this.binarySearch(key);
    if (index >= 0 && this.sortedKeys[index] === key) {
      this.sortedKeys.splice(index, 1);
    }
  }

  private binarySearch(key: string): number {
    let left = 0;
    let right = this.sortedKeys.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midKey = this.sortedKeys[mid];

      if (midKey === key) {
        return mid;
      } else if (midKey < key) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return -(left + 1);
  }

  async get(conversationKey: string): Promise<string | undefined> {
    await this.ensureInitialized();
    return this.cache.get(conversationKey);
  }

  async getByPrefix(prefix: string): Promise<string | undefined> {
    await this.ensureInitialized();

    // Binary search to find the first key that starts with prefix
    const start = this.binarySearch(prefix);

    // If we found an exact match or the insertion point
    const startIndex = start >= 0 ? start : -(start + 1);

    // Check if the key at startIndex starts with the prefix
    if (startIndex < this.sortedKeys.length) {
      const key = this.sortedKeys[startIndex];
      if (key.startsWith(prefix)) {
        return this.cache.get(key);
      }
    }

    return undefined;
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    await this.ensureInitialized();

    const existing = this.cache.get(conversationKey);
    if (existing === providerSessionId) {
      return; // No change needed
    }

    this.cache.set(conversationKey, providerSessionId);
    this.insertSortedKey(conversationKey);
    this.pendingWrites.push({ key: conversationKey, value: providerSessionId });
    this.scheduleFlush();
  }

  async delete(conversationKey: string): Promise<void> {
    await this.ensureInitialized();

    if (!this.cache.has(conversationKey)) {
      return; // Already deleted
    }

    this.cache.delete(conversationKey);
    this.removeSortedKey(conversationKey);
    this.pendingWrites.push({ key: conversationKey, value: undefined });
    this.scheduleFlush();
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    await this.ensureInitialized();

    const keysToDelete: string[] = [];

    // Find all keys with the prefix using binary search
    const start = this.binarySearch(prefix);
    const startIndex = start >= 0 ? start : -(start + 1);

    for (let i = startIndex; i < this.sortedKeys.length; i++) {
      const key = this.sortedKeys[i];
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      } else {
        break;
      }
    }

    if (keysToDelete.length === 0) return;

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.pendingWrites.push({ key, value: undefined });
    }

    this.rebuildSortedKeys();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (this.pendingWrites.length === 0) return;

    const writes = this.pendingWrites.splice(0, this.pendingWrites.length);
    this.compactionCounter += writes.length;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });

      // Append writes to log file
      const payload = writes
        .map((w) => JSON.stringify({ key: w.key, value: w.value }) + "\n")
        .join("");

      await appendFile(this.filePath, payload, "utf8");

      // Periodic compaction
      if (this.compactionCounter >= this.compactionThreshold) {
        await this.compact();
        this.compactionCounter = 0;
      }
    } catch (error) {
      // Restore pending writes on failure
      this.pendingWrites.unshift(...writes);
      throw error;
    }
  }

  private async compact(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;

    try {
      // Write current cache state as a clean file
      const payload = Array.from(this.cache.entries())
        .map(([key, value]) => JSON.stringify({ key, value }) + "\n")
        .join("");

      await writeFile(tempPath, payload || "", "utf8");
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

  /**
   * Force flush pending writes to disk.
   */
  async sync(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Get cache size for monitoring.
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Get statistics for monitoring.
   */
  getStats(): {
    cacheSize: number;
    pendingWrites: number;
    compactionCounter: number;
  } {
    return {
      cacheSize: this.cache.size,
      pendingWrites: this.pendingWrites.length,
      compactionCounter: this.compactionCounter,
    };
  }
}