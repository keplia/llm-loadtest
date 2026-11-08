import fs from 'node:fs';

// Tails a file that is still being written (k6's --out json=... NDJSON file)
// and invokes onLine for every complete line.
export class JsonlTailer {
  constructor(file, onLine, { intervalMs = 250 } = {}) {
    this.file = file;
    this.onLine = onLine;
    this.intervalMs = intervalMs;
    this.pos = 0;
    this.buf = '';
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  poll() {
    if (this.stopped) return;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return; // file not created yet
    }
    if (stat.size <= this.pos) return;

    const length = stat.size - this.pos;
    const chunk = Buffer.allocUnsafe(length);
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const bytes = fs.readSync(fd, chunk, 0, length, this.pos);
      this.pos += bytes;
      this.buf += chunk.subarray(0, bytes).toString('utf8');
    } catch {
      return;
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  // Read anything left and flush the trailing partial line.
  flush() {
    this.poll();
    if (this.buf.trim()) {
      const line = this.buf;
      this.buf = '';
      this.onLine(line);
    }
  }

  stop() {
    this.flush();
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
