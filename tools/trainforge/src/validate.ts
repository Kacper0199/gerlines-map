import { createRequire } from "node:module";

interface ValidatorMessage {
  readonly code: string;
  readonly message: string;
  readonly severity: number;
  readonly pointer?: string;
}

interface ValidatorReport {
  readonly issues: {
    readonly numErrors: number;
    readonly numWarnings: number;
    readonly messages: readonly ValidatorMessage[];
  };
}

interface KhronosValidator {
  version(): string;
  validateBytes(
    data: Uint8Array,
    options?: { readonly uri?: string; readonly maxIssues?: number },
  ): Promise<ValidatorReport>;
}

const khronos = createRequire(import.meta.url)("gltf-validator") as KhronosValidator;

export interface ValidationSummary {
  readonly errors: number;
  readonly warnings: number;
  /** Issue codes prefixed with their severity: E error, W warning, I info, H hint. */
  readonly codes: readonly string[];
}

const SEVERITY = ["E", "W", "I", "H"] as const;

export const validatorVersion = (): string => khronos.version();

/** Runs the Khronos glTF validator over one GLB and summarises its issues. */
export async function validateGlb(bytes: Uint8Array, uri: string): Promise<ValidationSummary> {
  const report = await khronos.validateBytes(bytes, { uri, maxIssues: 50 });
  const codes = [
    ...new Set(report.issues.messages.map((m) => `${SEVERITY[m.severity] ?? "?"}:${m.code}`)),
  ].sort();
  return { errors: report.issues.numErrors, warnings: report.issues.numWarnings, codes };
}
