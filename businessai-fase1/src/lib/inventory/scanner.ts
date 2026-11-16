/**
 * Barcode scanners (pure logic, used by the scanner component).
 *
 * USB and Bluetooth scanners in HID (keyboard) mode "type" the code very fast and usually
 * end with Enter (sometimes Tab). HidDetector tells such a burst apart from a person typing:
 * characters arriving at most `maxGapMs` apart, at least `minLength` of them, ended by Enter/Tab.
 * Not every scanner is configured the same way (suffix, speed): when in doubt the person can
 * type the code and press Enter, which always works.
 *
 * DuplicateGuard drops the same code read again within `windowMs` (a camera keeps seeing the
 * same label; a trigger pressed twice by accident). Counting by scanning deliberately accepts a
 * repeated code after the window has passed.
 */
export type ScanSource = 'hid' | 'camera' | 'manual'

export class HidDetector {
  private buf = ''
  private last = 0
  constructor(private readonly opts: { minLength?: number; maxGapMs?: number } = {}) {}
  /** Feed one key; returns the code when a scanner burst ends, otherwise null. */
  key(key: string, at: number): string | null {
    if (key === 'Enter' || key === 'Tab') {
      const code = this.buf
      this.reset()
      return code.length >= (this.opts.minLength ?? 4) ? code : null
    }
    if (key.length !== 1) return null            // Shift, arrows…
    // a pause longer than a scanner's means a person is typing: start again from this key
    if (this.buf && at - this.last > (this.opts.maxGapMs ?? 50)) this.buf = ''
    this.buf += key
    this.last = at
    return null
  }
  reset() { this.buf = ''; this.last = 0 }
}

export class DuplicateGuard {
  private seen = new Map<string, number>()
  constructor(private readonly windowMs = 1500) {}
  /** true when the code should be processed; false when it is the same read again too soon. */
  accept(code: string, at: number): boolean {
    const prev = this.seen.get(code)
    this.seen.set(code, at)
    for (const [k, t] of this.seen) if (at - t > this.windowMs * 4) this.seen.delete(k)
    return prev === undefined || at - prev > this.windowMs
  }
}

/** Formats the camera decoder reports, mapped to our symbologies (BarcodeDetector / ZXing names). */
export const CAMERA_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] as const
