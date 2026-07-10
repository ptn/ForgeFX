// AM4 driver unit tests — pure helpers, NO hardware. Covers the two additive port behaviors:
//   R-A1: am4NoneSelector — a raw-int `_cc` register that reads back the string 'None' is surfaced as a
//         labeled selector, never coerced to a broken 0 in the continuous-knob branch.
//   R-B3: am4DecodeEnrichment — the opt-in container decode (crcValid + scene names) degrades to null on
//         a malformed/corrupt dump instead of throwing (so the opaque backup/decode still succeeds).
import { RAW_INT_NONE_SENTINEL } from 'forgefx-midi/am4';
import { am4NoneSelector, am4DecodeEnrichment } from '../../src/drivers/am4.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const AM4_CASE_COUNT = 6;

export async function runAm4Tests(): Promise<void> {
  // 1. 'None' string → a single-option selector at the sentinel value (not a coerced 0 knob).
  {
    const sel = am4NoneSelector(0x1234, 'Bypass CC', 'None');
    assert(sel !== null, 'am4NoneSelector surfaces a "None" display as an enum');
    assertEqual(sel!.value, RAW_INT_NONE_SENTINEL, 'am4NoneSelector value is the None sentinel (128)');
    assertEqual(sel!.options.length, 1, 'am4NoneSelector has one option');
    assertEqual(sel!.options[0]!.label, 'None', 'am4NoneSelector option label is verbatim None');
    assertEqual(sel!.options[0]!.value, RAW_INT_NONE_SENTINEL, 'am4NoneSelector option value is the sentinel');
    assertEqual(sel!.id, 0x1234, 'am4NoneSelector keeps the encoded id');
  }

  // 2. a numeric display → null (the normal knob/enum path handles it, no override).
  {
    assertEqual(am4NoneSelector(1, 'Gain', 7.5), null, 'am4NoneSelector passes numbers through');
    assertEqual(am4NoneSelector(1, 'Gain', 0), null, 'am4NoneSelector passes 0 through');
  }

  // 3. a NUMERIC STRING (e.g. a CC number the reader stringified) → null, not swallowed as "None".
  {
    assertEqual(am4NoneSelector(1, 'CC', '64'), null, 'am4NoneSelector passes numeric strings through');
    assertEqual(am4NoneSelector(1, 'CC', ' '), null, 'am4NoneSelector ignores blank strings');
  }

  // 4. only genuinely non-numeric strings are captured.
  {
    const sel = am4NoneSelector(9, 'X', 'Off');
    assert(sel !== null && sel.options[0]!.label === 'Off', 'am4NoneSelector surfaces any non-numeric string label');
  }

  // 5. am4DecodeEnrichment on garbage bytes → null (never throws), so backup degrades gracefully.
  {
    const enrich = am4DecodeEnrichment(Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x15, 0x77, 0xf7]));
    assertEqual(enrich, null, 'am4DecodeEnrichment returns null on a truncated/corrupt dump');
  }

  // 6. am4DecodeEnrichment on an empty buffer → null.
  {
    assertEqual(am4DecodeEnrichment(new Uint8Array(0)), null, 'am4DecodeEnrichment returns null on empty bytes');
  }
}
