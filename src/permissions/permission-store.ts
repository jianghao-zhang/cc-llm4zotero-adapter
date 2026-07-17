/**
 * Pending permission request store for canUseTool callback.
 * Bridges async SDK callback with HTTP-based frontend resolution.
 */

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export type PendingPermission = {
  requestId: string;
  toolUseID: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
  createdAt: number;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

export type PendingPermissionEvent = {
  requestId: string;
  toolName: string;
  title?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
  input: Record<string, unknown>;
};

export interface PermissionStoreOptions {
  defaultTimeoutMs?: number;
  maxPendingRequests?: number;
  cleanupIntervalMs?: number;
}

/**
 * Permission store with improved timeout handling and monitoring.
 *
 * Features:
 * - Configurable timeout and max pending requests
 * - Periodic cleanup of orphaned requests
 * - Statistics for monitoring
 */
export class PermissionStore {
  private pending = new Map<string, PendingPermission>();
  private readonly defaultTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private stats = {
    totalCreated: 0,
    totalResolved: 0,
    totalTimedOut: 0,
    totalCleanedUp: 0,
  };

  constructor(options?: PermissionStoreOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 300_000; // 5 minutes
    this.maxPendingRequests = options?.maxPendingRequests ?? 100;

    // Start periodic cleanup
    const cleanupInterval = options?.cleanupIntervalMs ?? 60_000; // 1 minute
    this.cleanupTimer = setInterval(() => this.cleanupOrphaned(), cleanupInterval);
  }

  create(
    toolUseID: string,
    toolName: string,
    input: Record<string, unknown>,
    metadata: {
      title?: string;
      description?: string;
      displayName?: string;
      blockedPath?: string;
      decisionReason?: string;
    }
  ): { requestId: string; promise: Promise<PermissionResult> } {
    // Check capacity
    if (this.pending.size >= this.maxPendingRequests) {
      // Force cleanup of oldest pending request
      const oldestKey = this.findOldestPendingKey();
      if (oldestKey) {
        this.forceDeny(oldestKey, "Request superseded due to capacity limit");
      }
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.stats.totalCreated++;

    const promise = new Promise<PermissionResult>((resolve, reject) => {
      const pending: PendingPermission = {
        requestId,
        toolUseID,
        toolName,
        input,
        title: metadata.title,
        description: metadata.description,
        displayName: metadata.displayName,
        blockedPath: metadata.blockedPath,
        decisionReason: metadata.decisionReason,
        createdAt: Date.now(),
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.handleTimeout(requestId, toolUseID);
        }, this.defaultTimeoutMs),
      };

      this.pending.set(requestId, pending);
    });

    return { requestId, promise };
  }

  private handleTimeout(requestId: string, toolUseID: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);
    this.stats.totalTimedOut++;

    // Log timeout for debugging
    console.warn(
      `[permission-store] Request ${requestId} timed out after ${this.defaultTimeoutMs}ms (tool: ${pending.toolName})`
    );

    pending.resolve({
      behavior: "deny",
      message: `Permission request timed out after ${Math.round(this.defaultTimeoutMs / 1000)}s`,
      interrupt: false,
      toolUseID,
    });
  }

  private forceDeny(requestId: string, reason: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pending.delete(requestId);
    this.stats.totalCleanedUp++;

    pending.resolve({
      behavior: "deny",
      message: reason,
      interrupt: false,
      toolUseID: pending.toolUseID,
    });
  }

  private findOldestPendingKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, pending] of this.pending) {
      if (pending.createdAt < oldestTime) {
        oldestTime = pending.createdAt;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  /**
   * Cleanup orphaned requests that are older than 2x the timeout.
   */
  private cleanupOrphaned(): void {
    const orphanThreshold = Date.now() - (2 * this.defaultTimeoutMs);
    const keysToRemove: string[] = [];

    for (const [key, pending] of this.pending) {
      if (pending.createdAt < orphanThreshold) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.forceDeny(key, "Request cleaned up as orphaned");
    }

    if (keysToRemove.length > 0) {
      console.log(`[permission-store] Cleaned up ${keysToRemove.length} orphaned requests`);
    }
  }

  resolve(
    requestId: string,
    result: { approved: boolean; data?: unknown }
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    if (result.approved) {
      const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
      const rawUpdatedInput = typeof data.input === "string" ? data.input.trim() : "";
      let updatedInput: Record<string, unknown> = {};
      if (rawUpdatedInput) {
        try {
          const parsed = JSON.parse(rawUpdatedInput);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            updatedInput = parsed as Record<string, unknown>;
          }
        } catch {
          updatedInput = {};
        }
      }
      pending.resolve({
        behavior: "allow",
        updatedInput,
        toolUseID: pending.toolUseID,
      });
    } else {
      pending.resolve({
        behavior: "deny",
        message: typeof result.data === "string" ? result.data : "User denied action",
        interrupt: false,
        toolUseID: pending.toolUseID,
      });
    }

    this.pending.delete(requestId);
    this.stats.totalResolved++;
    return true;
  }

  getPendingForEvent(requestId: string): PendingPermissionEvent | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    return {
      requestId: p.requestId,
      toolName: p.toolName,
      title: p.title,
      description: p.description,
      displayName: p.displayName,
      blockedPath: p.blockedPath,
      decisionReason: p.decisionReason,
      input: p.input,
    };
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  listPendingRequestIds(limit = 3): string[] {
    if (limit <= 0) return [];
    return Array.from(this.pending.keys()).slice(-limit);
  }

  /**
   * Get statistics for monitoring.
   */
  getStats(): {
    pendingCount: number;
    maxPending: number;
    totalCreated: number;
    totalResolved: number;
    totalTimedOut: number;
    totalCleanedUp: number;
  } {
    return {
      pendingCount: this.pending.size,
      maxPending: this.maxPendingRequests,
      ...this.stats,
    };
  }

  /**
   * Cleanup all pending requests and stop cleanup timer.
   */
  cleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [, p] of this.pending) {
      if (p.timeoutId) clearTimeout(p.timeoutId);
      p.reject(new Error("Permission store cleanup"));
    }
    this.pending.clear();
  }
}

// Singleton instance for the process
export const globalPermissionStore = new PermissionStore();