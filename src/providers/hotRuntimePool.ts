import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent } from "../runtime.js";

type Waiter = {
  resolve: (value: IteratorResult<ProviderEvent>) => void;
  reject: (reason?: unknown) => void;
};

export type HotRuntimeTurn = {
  runId: string;
  sessionId?: string;
  finalText: string;
  awaitingAutoCompact: boolean;
  compactOnly: boolean;
  queueEvent: (event: ProviderEvent) => void;
  finish: () => void;
  fail: (error: Error) => void;
  events: AsyncIterable<ProviderEvent>;
};

export type HotRuntimeEntry = {
  conversationKey: string;
  mounts: Set<string>;
  closeTimer: ReturnType<typeof setTimeout> | null;
  closeRequested: boolean;
  lastActivityAt: number;
  query: Query | null;
  bootstrapPromise: Promise<void> | null;
  input: AsyncIterable<SDKUserMessage>;
  pushMessage: (message: SDKUserMessage) => void;
  closeInput: () => void;
  providerSessionId?: string;
  configSignature?: string;
  providerIdentity?: string;
  lastUsageSnapshot?: { contextTokens: number; contextWindow?: number };
  currentTurn: HotRuntimeTurn | null;
  currentTurnMessage?: SDKUserMessage;
  pendingEarlyRuntimeError?: Error;
  pendingEarlyRuntimeQueryOptions?: Record<string, unknown>;
  // Memory tracking
  estimatedSize: number;
};

function createMessageChannel(): {
  input: AsyncIterable<SDKUserMessage>;
  pushMessage: (message: SDKUserMessage) => void;
  closeInput: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  return {
    input: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
            }
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
        };
      },
    },
    pushMessage(message: SDKUserMessage) {
      if (closed) throw new Error("Hot runtime input is closed");
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: message, done: false });
        return;
      }
      queue.push(message);
    },
    closeInput() {
      closed = true;
      queue.length = 0;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
      }
    },
  };
}

export function createHotRuntimeTurn(runId: string): HotRuntimeTurn {
  const events: ProviderEvent[] = [];
  let done = false;
  let error: Error | null = null;
  let waiter: Waiter | null = null;

  const flush = () => {
    if (!waiter) return;
    if (events.length > 0) {
      const next = events.shift()!;
      const resolve = waiter.resolve;
      waiter = null;
      resolve({ value: next, done: false });
      return;
    }
    if (error) {
      const reject = waiter.reject;
      waiter = null;
      reject(error);
      return;
    }
    if (done) {
      const resolve = waiter.resolve;
      waiter = null;
      resolve({ value: undefined, done: true } as IteratorResult<ProviderEvent>);
    }
  };

  return {
    runId,
    finalText: "",
    awaitingAutoCompact: false,
    compactOnly: false,
    queueEvent(event: ProviderEvent) {
      if (done || error) return;
      events.push(event);
      flush();
    },
    finish() {
      done = true;
      flush();
    },
    fail(nextError: Error) {
      if (done || error) return;
      error = nextError;
      flush();
    },
    events: {
      [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
        return {
          next(): Promise<IteratorResult<ProviderEvent>> {
            if (events.length > 0) {
              return Promise.resolve({ value: events.shift()!, done: false });
            }
            if (error) {
              return Promise.reject(error);
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true } as IteratorResult<ProviderEvent>);
            }
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
        };
      },
    },
  };
}

/**
 * Estimate memory size of a message for LRU eviction decisions.
 * This is a rough estimate to help manage memory usage.
 */
function estimateMessageSize(message: SDKUserMessage | undefined): number {
  if (!message) return 0;

  let size = 100; // Base overhead

  // Estimate size of message content
  if (message.message) {
    const content = message.message.content;
    if (typeof content === "string") {
      size += content.length * 2; // UTF-16 characters
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && "text" in block) {
          size += (block.text as string).length * 2;
        } else if (block.type === "image" && "source" in block) {
          const source = block.source as { type: string; data?: string };
          if (source.type === "base64" && source.data) {
            size += source.data.length * 0.75; // Base64 -> binary estimate
          }
        }
      }
    }
  }

  return size;
}

export function createHotRuntimeEntry(conversationKey: string): HotRuntimeEntry {
  const channel = createMessageChannel();
  return {
    conversationKey,
    mounts: new Set<string>(),
    closeTimer: null,
    closeRequested: false,
    lastActivityAt: Date.now(),
    query: null,
    bootstrapPromise: null,
    input: channel.input,
    pushMessage: channel.pushMessage,
    closeInput: channel.closeInput,
    providerSessionId: undefined,
    configSignature: undefined,
    providerIdentity: undefined,
    lastUsageSnapshot: undefined,
    currentTurn: null,
    currentTurnMessage: undefined,
    pendingEarlyRuntimeError: undefined,
    pendingEarlyRuntimeQueryOptions: undefined,
    estimatedSize: 0,
  };
}

export interface HotRuntimePoolOptions {
  graceMs?: number;
  maxEntries?: number;
  maxMemoryBytes?: number;
}

/**
 * Pool of hot runtime entries with LRU eviction strategy.
 *
 * Features:
 * - Maximum entries limit to prevent unbounded growth
 * - Memory-based eviction when estimated size exceeds threshold
 * - Idle timeout for automatic cleanup
 * - Active monitoring via getStats()
 */
export class HotRuntimePool {
  private readonly entries = new Map<string, HotRuntimeEntry>();
  private readonly accessOrder: string[] = [];
  private readonly graceMs: number;
  private readonly maxEntries: number;
  private readonly maxMemoryBytes: number;

  constructor(options?: HotRuntimePoolOptions) {
    this.graceMs = options?.graceMs ?? 5 * 60 * 1000; // 5 minutes default
    this.maxEntries = options?.maxEntries ?? 50; // Maximum 50 concurrent sessions
    this.maxMemoryBytes = options?.maxMemoryBytes ?? 500 * 1024 * 1024; // 500MB estimate
  }

  ensure(conversationKey: string): HotRuntimeEntry {
    const existing = this.entries.get(conversationKey);
    if (existing) {
      this.touchAccess(conversationKey);
      return existing;
    }

    // Check capacity before creating new entry
    this.enforceCapacityLimits();

    const created = createHotRuntimeEntry(conversationKey);
    this.entries.set(conversationKey, created);
    this.accessOrder.push(conversationKey);
    return created;
  }

  get(conversationKey: string): HotRuntimeEntry | undefined {
    const entry = this.entries.get(conversationKey);
    if (entry) {
      this.touchAccess(conversationKey);
    }
    return entry;
  }

  retain(conversationKey: string, mountId: string): HotRuntimeEntry {
    const entry = this.ensure(conversationKey);
    entry.mounts.add(mountId);
    entry.lastActivityAt = Date.now();
    entry.closeRequested = false;
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    this.touchAccess(conversationKey);
    return entry;
  }

  release(conversationKey: string, mountId: string, onExpire: (entry: HotRuntimeEntry) => void): void {
    const entry = this.entries.get(conversationKey);
    if (!entry) return;
    entry.mounts.delete(mountId);
    entry.lastActivityAt = Date.now();
    this.scheduleCloseIfIdle(entry, onExpire);
  }

  scheduleCloseIfIdle(entry: HotRuntimeEntry, onExpire: (entry: HotRuntimeEntry) => void): void {
    if (entry.mounts.size > 0 || entry.currentTurn) return;
    if (entry.closeTimer) return;
    entry.closeRequested = true;
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null;
      if (entry.mounts.size > 0 || entry.currentTurn) return;
      this.delete(entry.conversationKey);
      onExpire(entry);
    }, this.graceMs);
  }

  delete(conversationKey: string): HotRuntimeEntry | undefined {
    const entry = this.entries.get(conversationKey);
    if (!entry) return undefined;
    this.entries.delete(conversationKey);

    // Remove from access order
    const idx = this.accessOrder.indexOf(conversationKey);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }

    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    return entry;
  }

  /**
   * Update access order for LRU tracking.
   */
  private touchAccess(conversationKey: string): void {
    const idx = this.accessOrder.indexOf(conversationKey);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(conversationKey);
  }

  /**
   * Estimate total memory usage across all entries.
   */
  private estimateTotalMemory(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.estimatedSize;
      // Add estimated size of current turn message
      total += estimateMessageSize(entry.currentTurnMessage);
    }
    return total;
  }

  /**
   * Enforce capacity limits by evicting least recently used entries.
   */
  private enforceCapacityLimits(): void {
    // Check entry count limit
    while (this.entries.size >= this.maxEntries && this.accessOrder.length > 0) {
      const lruKey = this.accessOrder.shift();
      if (lruKey && this.entries.has(lruKey)) {
        const entry = this.entries.get(lruKey);
        if (entry && entry.mounts.size === 0 && !entry.currentTurn) {
          this.delete(lruKey);
          console.log(`[hot-runtime] Evicted entry ${lruKey} due to max entries limit`);
        }
      }
    }

    // Check memory limit
    const currentMemory = this.estimateTotalMemory();
    if (currentMemory > this.maxMemoryBytes) {
      // Evict LRU entries until under limit
      const keysToEvict: string[] = [];
      let projectedMemory = currentMemory;

      for (const key of this.accessOrder) {
        if (projectedMemory <= this.maxMemoryBytes * 0.8) break;
        const entry = this.entries.get(key);
        if (entry && entry.mounts.size === 0 && !entry.currentTurn) {
          keysToEvict.push(key);
          projectedMemory -= entry.estimatedSize + estimateMessageSize(entry.currentTurnMessage);
        }
      }

      for (const key of keysToEvict) {
        this.delete(key);
        console.log(`[hot-runtime] Evicted entry ${key} due to memory limit`);
      }
    }
  }

  /**
   * Get pool statistics for monitoring.
   */
  getStats(): {
    entryCount: number;
    maxEntries: number;
    estimatedMemoryBytes: number;
    maxMemoryBytes: number;
    activeMounts: number;
    idleEntries: number;
  } {
    let activeMounts = 0;
    let idleEntries = 0;
    let estimatedMemory = 0;

    for (const entry of this.entries.values()) {
      activeMounts += entry.mounts.size;
      if (entry.mounts.size === 0 && !entry.currentTurn) {
        idleEntries++;
      }
      estimatedMemory += entry.estimatedSize + estimateMessageSize(entry.currentTurnMessage);
    }

    return {
      entryCount: this.entries.size,
      maxEntries: this.maxEntries,
      estimatedMemoryBytes: estimatedMemory,
      maxMemoryBytes: this.maxMemoryBytes,
      activeMounts,
      idleEntries,
    };
  }

  /**
   * Force cleanup of all idle entries.
   */
  cleanupIdle(onExpire: (entry: HotRuntimeEntry) => void): number {
    let cleaned = 0;
    for (const [key, entry] of this.entries) {
      if (entry.mounts.size === 0 && !entry.currentTurn) {
        this.delete(key);
        onExpire(entry);
        cleaned++;
      }
    }
    return cleaned;
  }
}