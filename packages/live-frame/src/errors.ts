export type FrameErrorCode =
  | "truncated"
  | "bad_magic"
  | "unsupported_version"
  | "wrong_kind"
  | "checksum"
  | "corrupt";

/** Raised by every decoder for input it cannot read; `code` tells why (FORMAT.md section 2.3). */
export class FrameDecodeError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FrameDecodeError";
    this.code = code;
  }
}

export function corrupt(message: string): never {
  throw new FrameDecodeError("corrupt", message);
}
