// A note of each error in a log file next to the autosave copies, so a problem
// seen once can be looked into afterwards.
import { call } from "./backend";

export async function logError(error: unknown): Promise<void> {
  const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  try {
    await call("log_error", { message: text });
  } catch {
    // No log (a browser without the app): the console has it.
    console.error(error);
  }
}
