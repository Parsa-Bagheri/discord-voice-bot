import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stereo48kToMono16k,
  Upsampler24kTo48kStereo,
  s16leToFloat32,
} from './resample.js';

function s16(samples: readonly number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buf.writeInt16LE(value, i * 2));
  return buf;
}

test('stereo48kToMono16k: 20ms stereo frame becomes 640 bytes', () => {
  const input = Buffer.alloc(3840);
  assert.equal(stereo48kToMono16k(input).length, 640);
});

test('stereo48kToMono16k: averages L/R and groups of 3 mono samples', () => {
  const input = s16([
    50, 150, // mono 100
    100, 300, // mono 200
    250, 350, // mono 300
  ]);
  const out = stereo48kToMono16k(input);

  assert.equal(out.length, 2);
  assert.equal(out.readInt16LE(0), 200);
});

test('stereo48kToMono16k: rounds fractional averages', () => {
  const input = s16([
    100, 200, // mono 150
    300, 500, // mono 400
    -100, 100, // mono 0
  ]);
  const out = stereo48kToMono16k(input);

  assert.equal(out.readInt16LE(0), 183);
});

test('stereo48kToMono16k: rejects lengths that are not a multiple of 12 bytes', () => {
  for (const length of [1, 2, 11, 13, 3841]) {
    assert.throws(() => stereo48kToMono16k(Buffer.alloc(length)), RangeError);
  }
  assert.equal(stereo48kToMono16k(Buffer.alloc(0)).length, 0);
});

test('Upsampler24kTo48kStereo: doubles samples and duplicates to stereo', () => {
  const up = new Upsampler24kTo48kStereo();
  const out = up.process(s16([100, 200, 300, 400]));

  assert.equal(out.length, 32);
  assert.equal(out.length, 4 * 4 * 2);
});

test('Upsampler24kTo48kStereo: outputs midpoint then sample, duplicated to L/R', () => {
  const up = new Upsampler24kTo48kStereo();
  const out = up.process(s16([100, 200]));

  const values = [0, 2, 4, 6].map((offset) => out.readInt16LE(offset));
  assert.deepEqual(values, [50, 50, 100, 100]);

  const next = [8, 10, 12, 14].map((offset) => out.readInt16LE(offset));
  assert.deepEqual(next, [150, 150, 200, 200]);
});

test('Upsampler24kTo48kStereo: chunk boundaries are seamless', () => {
  const samples = s16([100, -200, 300, 400, -500, 600, 700, -800]);

  const split = new Upsampler24kTo48kStereo();
  const splitOut = Buffer.concat([
    split.process(samples.subarray(0, 6)),
    split.process(samples.subarray(6)),
  ]);

  const whole = new Upsampler24kTo48kStereo();
  const wholeOut = whole.process(samples);

  assert.deepEqual(splitOut, wholeOut);
});

test('Upsampler24kTo48kStereo: buffers a dangling odd byte across calls', () => {
  const samples = s16([1234, -5678, 910, -42]);

  const split = new Upsampler24kTo48kStereo();
  const first = split.process(samples.subarray(0, 5));
  const second = split.process(samples.subarray(5));

  assert.equal(first.length, 16);
  assert.equal(second.length, 16);

  const whole = new Upsampler24kTo48kStereo();
  assert.deepEqual(Buffer.concat([first, second]), whole.process(samples));
});

test('Upsampler24kTo48kStereo: reset clears carried state', () => {
  const samples = s16([100, 200]);

  const up = new Upsampler24kTo48kStereo();
  const before = up.process(samples);
  up.reset();
  const after = up.process(samples);

  assert.deepEqual(after, before);
});

test('s16leToFloat32: converts and scales samples', () => {
  const input = Buffer.concat([s16([-32768, 0, 16384, 32767]), Buffer.from([0x7f])]);
  const out = s16leToFloat32(input);

  assert.equal(out.length, 4);
  assert.equal(out[0], -1);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0.5);
  assert.equal(out[3], 32767 / 32768);
});

test('s16leToFloat32: empty input yields an empty array', () => {
  assert.equal(s16leToFloat32(Buffer.alloc(0)).length, 0);
});
