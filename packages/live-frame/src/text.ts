interface Utf8Globals {
  readonly TextEncoder: new () => { encode(text: string): Uint8Array };
  readonly TextDecoder: new (
    label: string,
    options: { fatal: boolean },
  ) => { decode(bytes: Uint8Array): string };
}

const globals = globalThis as unknown as Utf8Globals;

export function utf8Encoder(): { encode(text: string): Uint8Array } {
  return new globals.TextEncoder();
}

/** A decoder that throws on invalid UTF-8. */
export function strictUtf8Decoder(): { decode(bytes: Uint8Array): string } {
  return new globals.TextDecoder("utf-8", { fatal: true });
}
