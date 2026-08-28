import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface SqliteSaverFactoryOptions {
  connectionString: string;
  onWarning?: (message: string, error: unknown) => void;
}

export interface CheckpointerFactoryResult {
  checkpointer: BaseCheckpointSaver;
  persistent: boolean;
  close(): void;
}

/**
 * Load native SQLite lazily. Production must fail closed when the native module
 * is unavailable; silently switching to memory would make persisted interrupts
 * appear resumable until the process restarts.
 */
export async function createSqliteSaver(
  options: SqliteSaverFactoryOptions,
): Promise<CheckpointerFactoryResult> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("SQLite connection string must not be empty");
  }
  try {
    const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
    const saver = SqliteSaver.fromConnString(options.connectionString);
    let closed = false;
    return {
      checkpointer: saver,
      persistent: options.connectionString !== ":memory:",
      close: () => {
        if (closed) return;
        closed = true;
        if (saver.db.open) saver.db.close();
      },
    };
  } catch (error) {
    const message = "Persistent SQLite checkpointer is required but unavailable";
    if (options.onWarning !== undefined) options.onWarning(message, error);
    throw new Error(message, { cause: error });
  }
}
