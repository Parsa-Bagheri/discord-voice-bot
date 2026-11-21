function toS16(value: number): number {
  return Math.round(Math.min(32767, Math.max(-32768, value)));
}

/** 48kHz stereo s16le -> 16kHz mono s16le. Downmix by averaging L/R, then decimate by 3 averaging each group of 3 mono samples (simple anti-alias box filter). Input length must be a multiple of 12 bytes (3 stereo frames); if not, throw RangeError. Return a new Buffer. */
export function stereo48kToMono16k(input: Buffer): Buffer {
  if (input.length % 12 !== 0) {
    throw new RangeError(
      `stereo48kToMono16k: input length must be a multiple of 12 bytes, got ${input.length}`,
    );
  }

  const out = Buffer.alloc((input.length / 12) * 2);
  let o = 0;

  for (let i = 0; i < input.length; i += 12) {
    let sum = 0;
    for (let f = 0; f < 12; f += 4) {
      const left = input.readInt16LE(i + f);
      const right = input.readInt16LE(i + f + 2);
      sum += (left + right) / 2;
    }
    out.writeInt16LE(toS16(sum / 3), o);
    o += 2;
  }

  return out;
}

/** Stateful 24kHz mono s16le -> 48kHz stereo s16le upsampler using linear interpolation. Keeps the last sample from the previous chunk so chunk boundaries are seamless. For each input sample s[i], output two mono samples: midpoint(prev, s[i]) then s[i], where prev is the previous input sample (carried across calls, initially 0). Each mono output sample is duplicated to L and R. Odd-length input (half sample) must be handled by buffering the dangling byte until the next call. reset() clears state. */
export class Upsampler24kTo48kStereo {
  private prev = 0;
  private pending: number | null = null;

  process(input: Buffer): Buffer {
    let data = input;
    if (this.pending !== null) {
      const first = Buffer.alloc(1);
      first[0] = this.pending;
      data = Buffer.concat([first, input]);
      this.pending = null;
    }

    const sampleCount = Math.floor(data.length / 2);
    const out = Buffer.alloc(sampleCount * 8);
    let o = 0;

    for (let i = 0; i < sampleCount; i++) {
      const sample = data.readInt16LE(i * 2);
      const mid = toS16((this.prev + sample) / 2);
      out.writeInt16LE(mid, o);
      o += 2;
      out.writeInt16LE(mid, o);
      o += 2;
      out.writeInt16LE(sample, o);
      o += 2;
      out.writeInt16LE(sample, o);
      o += 2;
      this.prev = sample;
    }

    if (data.length % 2 !== 0) {
      this.pending = data.readUInt8(data.length - 1);
    }

    return out;
  }

  reset(): void {
    this.prev = 0;
    this.pending = null;
  }
}

/** s16le Buffer -> Float32Array in [-1, 1) by dividing by 32768. Ignore a trailing odd byte. */
export function s16leToFloat32(input: Buffer): Float32Array {
  const count = Math.floor(input.length / 2);
  const out = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    out[i] = input.readInt16LE(i * 2) / 32768;
  }

  return out;
}
