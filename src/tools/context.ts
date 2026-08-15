export interface ToolContext {
  /** Upper bound on bytes returned by any single content-bearing tool. */
  maxFileBytes: number;
  /** When false, mutating tools are never registered at all. */
  allowWrite: boolean;
}
