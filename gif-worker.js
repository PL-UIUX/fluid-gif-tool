// Web Worker that encodes GIF frames using gifenc.
// Runs off the main thread so the animation stays smooth during recording.
//
// Protocol (messages from main thread):
//   { type: "start", width, height, fps }  -> initialise encoder
//   { type: "frame", data: Uint8Array, width, height }  -> append a frame (RGBA)
//   { type: "finish" }                      -> flush and return the GIF bytes
//
// Message back to main thread:
//   { type: "done", data: ArrayBuffer }     -> complete GIF file

// gifenc ships as CommonJS (uses module.exports). Shim a module object so
// importScripts works inside a classic Web Worker.
var module = { exports: {} };
var exports = module.exports;
importScripts("gifenc.js");
var gifenc = module.exports;

// 4x4 ordered dithering Bayer matrix (values 0..15). Applied per-pixel before
// quantisation to break up colour banding on smooth gradients.
var BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];
// Dither strength in RGB units (0..255). Small enough to avoid noise but
// large enough to scatter banding.
var DITHER_STRENGTH = 10;

// Apply a light ordered dither directly into the rgba buffer (in place).
function applyDither(rgba, width, height) {
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var m = BAYER_4X4[(y & 3) * 4 + (x & 3)] / 16 - 0.5; // -0.5..0.5
      var off = (y * width + x) * 4;
      var r = rgba[off] + m * DITHER_STRENGTH;
      var g = rgba[off + 1] + m * DITHER_STRENGTH;
      var b = rgba[off + 2] + m * DITHER_STRENGTH;
      rgba[off] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgba[off + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgba[off + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
}

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "start") {
    var width = msg.width;
    var height = msg.height;
    // gifenc delays are in 1/100th of a second.
    var delay = Math.round(100 / msg.fps);

    var gif = gifenc.GIFEncoder();
    self._state = { gif: gif, width: width, height: height, delay: delay, frameCount: 0 };
    return;
  }

  if (msg.type === "frame") {
    var st = self._state;
    var rgba = msg.data; // Uint8Array RGBA
    var w = st.width;
    var h = st.height;

    // Ordered dithering to break up gradient banding.
    applyDither(rgba, w, h);

    // Quantise every frame independently so its palette always matches the
    // current colours. rgb565 gives finer colour bins (65536) than rgba4444.
    var palette = gifenc.quantize(rgba, 256, { format: "rgb565" });
    var index = gifenc.applyPalette(rgba, palette, "rgb565");

    st.gif.writeFrame(index, w, h, {
      palette: palette,
      delay: st.delay,
    });
    st.frameCount++;
    return;
  }

  if (msg.type === "finish") {
    var st = self._state;
    st.gif.finish();
    var bytes = st.gif.bytes(); // Uint8Array
    // Transfer the underlying buffer back (zero-copy).
    self.postMessage({ type: "done", data: bytes.buffer, frameCount: st.frameCount }, [bytes.buffer]);
    self._state = null;
    return;
  }
};
