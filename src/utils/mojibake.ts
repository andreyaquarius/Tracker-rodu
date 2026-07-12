let windows1251ByteByCharacter: ReadonlyMap<string, number> | undefined;

function windows1251Bytes(value: string): number[] | undefined {
  if (!windows1251ByteByCharacter) {
    try {
      const decoder = new TextDecoder("windows-1251");
      const entries: Array<[string, number]> = [];
      for (let byte = 0x80; byte <= 0xff; byte += 1) {
        const character = decoder.decode(Uint8Array.of(byte));
        if (character !== "\ufffd") entries.push([character, byte]);
      }
      windows1251ByteByCharacter = new Map(entries);
    } catch {
      windows1251ByteByCharacter = new Map();
    }
  }

  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
      continue;
    }
    const byte = windows1251ByteByCharacter.get(character);
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  return bytes;
}

function utf8SequenceScore(bytes: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index]!;
    const continuationCount =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first >= 0xe0 && first <= 0xef
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : 0;
    if (!continuationCount) continue;
    let valid = true;
    for (let offset = 1; offset <= continuationCount; offset += 1) {
      const next = bytes[index + offset];
      if (next === undefined || next < 0x80 || next > 0xbf) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    score += 1;
    index += continuationCount;
  }
  return score;
}

function decodeWindows1251Mojibake(value: string): string | undefined {
  const bytes = windows1251Bytes(value);
  if (!bytes?.length || utf8SequenceScore(bytes) === 0) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return undefined;
  }
}

/**
 * Repairs UTF-8 text that was once decoded as Windows-1251. A candidate is
 * accepted only when the original is a valid UTF-8 byte sequence in that
 * legacy encoding and the decoded result contains fewer such sequences.
 */
export function repairMojibakeText(value: unknown): string {
  let current = String(value ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    const currentBytes = windows1251Bytes(current);
    const candidate = decodeWindows1251Mojibake(current);
    if (!currentBytes || !candidate || candidate === current) break;
    const candidateBytes = windows1251Bytes(candidate);
    if (
      !candidateBytes ||
      utf8SequenceScore(candidateBytes) >= utf8SequenceScore(currentBytes) ||
      !/[А-Яа-яІіЇїЄєҐґ]/.test(candidate)
    ) {
      break;
    }
    current = candidate;
  }
  return current;
}
