/** An app serves the automation protocol on stdin/stdout only when this variable is `1`. */
export const AUTOMATION_ENV = "GPUIX_AUTOMATION"

export function automationRequested(env: Record<string, string | undefined>): boolean {
  return env[AUTOMATION_ENV] === "1"
}
