import { Transform } from 'node:stream';

/**
 * Minimal Ogg demuxer: turns an Ogg/Opus byte stream (from ffmpeg) into raw
 * Opus packets, one per chunk. The OpusHead/OpusTags header packets are dropped.
 */
export class OggOpusDemuxer extends Transform {
  constructor() {
    super({ readableObjectMode: true });
    this.buf = Buffer.alloc(0);
    this.partial = [];
  }

  _transform(chunk, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.#readPage());
      cb();
    } catch (err) {
      cb(err);
    }
  }

  #readPage() {
    const b = this.buf;
    if (b.length < 27) return false;
    if (b.toString('latin1', 0, 4) !== 'OggS') {
      const idx = b.indexOf('OggS', 1, 'latin1');
      this.buf = idx === -1 ? Buffer.alloc(0) : b.subarray(idx);
      return idx !== -1;
    }
    const segCount = b[26];
    if (b.length < 27 + segCount) return false;
    let bodyLen = 0;
    for (let i = 0; i < segCount; i++) bodyLen += b[27 + i];
    const total = 27 + segCount + bodyLen;
    if (b.length < total) return false;

    let off = 27 + segCount;
    for (let i = 0; i < segCount; i++) {
      const len = b[27 + i];
      this.partial.push(b.subarray(off, off + len));
      off += len;
      if (len < 255) {
        const packet = Buffer.concat(this.partial);
        this.partial = [];
        const head = packet.toString('latin1', 0, 8);
        if (head !== 'OpusHead' && head !== 'OpusTags') this.push(packet);
      }
    }
    this.buf = b.subarray(total);
    return true;
  }
}
