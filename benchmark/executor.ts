/**
 * The coding-executor boundary. Both the OpenCode SDK and Eve-native sandbox
 * execution implement this interface; the comparison spike measures them
 * against the same task prompt, repository state, model context, and tool
 * permissions.
 */

export type ExecutorId = "opencode" | "eve-native";

/** A task in the progressive benchmark ladder. */
export interface TaskSpec {
  /** Human-readable task id (e.g. "01-hello-world"). */
  id: string;
  /** The exact prompt handed to the executor. */
  prompt: string;
  /** Model context shared by both executors. */
  modelContext: ModelContext;
  /** Tool permissions shared by both executors. */
  permissions: ToolPermissions;
}

export interface ModelContext {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolPermissions {
  /** Executors may run shell commands in the fixture workspace. */
  shell: boolean;
  /** Executors may read files in the fixture workspace. */
  read: boolean;
  /** Executors may write files in the fixture workspace. */
  write: boolean;
}

/** Structured completion evidence an executor returns after a task. */
export interface ExecutionResult {
  success: boolean;
  filesChanged: string[];
  checksRun: { name: string; exitCode: number; output?: string }[];
  tokenUsage?: { input: number; output: number; total: number };
  structuredOutput?: Record<string, unknown>;
  interrupted: boolean;
  resumed: boolean;
  securityObservations?: string[];
  error?: string;
}

/** A run of one executor against one task. */
export interface ExecutorRun {
  executor: ExecutorId;
  taskId: string;
  result: ExecutionResult;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface Executor {
  readonly id: ExecutorId;
  /**
   * Execute a task against a writable fixture repository and return structured
   * completion evidence. Must pause once for human confirmation and resume.
   */
  run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult>;
  /** Stop the current run cleanly, preserving resumable state. */
  interrupt(): Promise<void>;
  /** Resume an interrupted run. */
  resume(): Promise<ExecutionResult | undefined>;
  /** Release resources (server, session, container). */
  close(): Promise<void>;
}
