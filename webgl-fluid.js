/*
MIT License

Copyright (c) 2017 Pavel Dobryakov
Adapted by Thomas Kabalin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

"use strict";

// Simulation section

function resizeCanvas() {
  let width = scaleByPixelRatio(canvas.clientWidth);
  let height = scaleByPixelRatio(canvas.clientHeight);
  if (canvas.width != width || canvas.height != height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function scaleByPixelRatio(input) {
  let pixelRatio = window.devicePixelRatio || 1;
  return Math.floor(input * pixelRatio);
}

const canvas = document.getElementsByTagName("canvas")[0];
resizeCanvas();

// Set the properties from the config file
fetch("config.json?v=" + Date.now())
  .then((response) => response.json())
  .then((config) => {
    runSimulation(config);
  })
  .catch((error) => {
    // Handle errors if the config fails to load
    alert("Failed to load config. Check the file or network.");
  });

function runSimulation(config) {
  function pointerPrototype() {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 0, 300];
  }

  let pointers = [];
  let splatStack = [];
  pointers.push(new pointerPrototype());

  // Mask rectangle (x, y, w, h) in UV space, restricting where fluid is visible.
  let maskRect = { x: 0, y: 0, w: 1, h: 1 };
  let maskImageWidth = 0;  // original image pixel width  (0 = no image uploaded)
  let maskImageHeight = 0; // original image pixel height
  let maskTexture = null;  // WebGL texture of the uploaded image (null = none)
  let overlayTexture = null; // top-layer PNG texture (default overlay.png, replaceable)

  // ---- GIF recording state ----
  let isRecording = false;
  let recordFBO = null;          // offscreen framebuffer reused for every frame
  let gifWorker = null;
  let recordFrameCount = 0;
  let recordTargetFrames = 0;
  let recordInterval = 0;        // seconds between captured frames
  let recordAccumulator = 0;     // time accumulator for frame pacing

  const { gl, ext } = getWebGLContext(canvas);

  if (isMobile()) {
    config.DYE_RESOLUTION = 512;
  }
  if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
  }

  function getWebGLContext(canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };

    let gl = canvas.getContext("webgl2", params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
      gl =
        canvas.getContext("webgl", params) ||
        canvas.getContext("experimental-webgl", params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension("EXT_color_buffer_float");
      supportLinearFiltering = gl.getExtension("OES_texture_float_linear");
    } else {
      halfFloat = gl.getExtension("OES_texture_half_float");
      supportLinearFiltering = gl.getExtension("OES_texture_half_float_linear");
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2
      ? gl.HALF_FLOAT
      : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2) {
      formatRGBA = getSupportedFormat(
        gl,
        gl.RGBA16F,
        gl.RGBA,
        halfFloatTexType
      );
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
      gl,
      ext: {
        formatRGBA,
        formatRG,
        formatR,
        halfFloatTexType,
        supportLinearFiltering,
      },
    };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F:
          return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F:
          return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default:
          return null;
      }
    }

    return {
      internalFormat,
      format,
    };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      4,
      4,
      0,
      format,
      type,
      null
    );

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
  }

  function isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
  }

  function captureScreenshot() {
    let res = getResolution(config.CAPTURE_RESOLUTION);
    let target = createFBO(
      res.width,
      res.height,
      ext.formatRGBA.internalFormat,
      ext.formatRGBA.format,
      ext.halfFloatTexType,
      gl.NEAREST
    );
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    let datauri = captureCanvas.toDataURL();
    downloadURI("fluid.png", datauri);
    URL.revokeObjectURL(datauri);
  }

  function framebufferToTexture(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(
      0,
      0,
      target.width,
      target.height,
      gl.RGBA,
      gl.FLOAT,
      texture
    );
    return texture;
  }

  // Like framebufferToTexture but only reads a sub-rectangle (rx, ry, rw, rh,
  // pixel units, origin bottom-left) and returns Uint8 0..255 with Y already
  // flipped to top-left. Used to crop the GIF capture to the image region.
  function framebufferToTextureRect(target, rx, ry, rw, rh) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = rw * rh * 4;
    let texture = new Float32Array(length);
    gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.FLOAT, texture);
    // Clamp to 0..255 and flip Y (readPixels is bottom-up).
    let result = new Uint8Array(length);
    let id = 0;
    for (let i = rh - 1; i >= 0; i--) {
      for (let j = 0; j < rw; j++) {
        let nid = i * rw * 4 + j * 4;
        result[nid + 0] = clamp01(texture[id + 0]) * 255;
        result[nid + 1] = clamp01(texture[id + 1]) * 255;
        result[nid + 2] = clamp01(texture[id + 2]) * 255;
        result[nid + 3] = clamp01(texture[id + 3]) * 255;
        id += 4;
      }
    }
    return result;
  }

  function normalizeTexture(texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
      for (let j = 0; j < width; j++) {
        let nid = i * width * 4 + j * 4;
        result[nid + 0] = clamp01(texture[id + 0]) * 255;
        result[nid + 1] = clamp01(texture[id + 1]) * 255;
        result[nid + 2] = clamp01(texture[id + 2]) * 255;
        result[nid + 3] = clamp01(texture[id + 3]) * 255;
        id += 4;
      }
    }
    return result;
  }

  function clamp01(input) {
    return Math.min(Math.max(input, 0), 1);
  }

  function textureToCanvas(texture, width, height) {
    let captureCanvas = document.createElement("canvas");
    let ctx = captureCanvas.getContext("2d");
    captureCanvas.width = width;
    captureCanvas.height = height;

    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);

    return captureCanvas;
  }

  function downloadURI(filename, uri) {
    let link = document.createElement("a");
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  class Material {
    constructor(vertexShader, fragmentShaderSource) {
      this.vertexShader = vertexShader;
      this.fragmentShaderSource = fragmentShaderSource;
      this.programs = [];
      this.activeProgram = null;
      this.uniforms = [];
    }

    setKeywords(keywords) {
      let hash = 0;
      for (let i = 0; i < keywords.length; i++) hash += hashCode(keywords[i]);

      let program = this.programs[hash];
      if (program == null) {
        let fragmentShader = compileShader(
          gl.FRAGMENT_SHADER,
          this.fragmentShaderSource,
          keywords
        );
        program = createProgram(this.vertexShader, fragmentShader);
        this.programs[hash] = program;
      }

      if (program == this.activeProgram) return;

      this.uniforms = getUniforms(program);
      this.activeProgram = program;
    }

    bind() {
      gl.useProgram(this.activeProgram);
    }
  }

  class Program {
    constructor(vertexShader, fragmentShader) {
      this.uniforms = {};
      this.program = createProgram(vertexShader, fragmentShader);
      this.uniforms = getUniforms(this.program);
    }

    bind() {
      gl.useProgram(this.program);
    }
  }

  function createProgram(vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      console.trace(gl.getProgramInfoLog(program));

    return program;
  }

  function getUniforms(program) {
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      let uniformName = gl.getActiveUniform(program, i).name;
      uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
  }

  function compileShader(type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      console.trace(gl.getShaderInfoLog(shader));

    return shader;
  }

  function addKeywords(source, keywords) {
    if (keywords == null) return source;
    let keywordsString = "";
    keywords.forEach((keyword) => {
      keywordsString += "#define " + keyword + "\n";
    });
    return keywordsString + source;
  }

  const baseVertexShader = compileShader(
    gl.VERTEX_SHADER,
    `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`
  );

  const blurVertexShader = compileShader(
    gl.VERTEX_SHADER,
    `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`
  );

  const blurShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`
  );

  const copyShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`
  );

  const clearShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`
  );

  const colorShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`
  );

  // Draws the uploaded image inside the mask rectangle (uMaskRect = x,y,w,h).
  // Outside the rectangle it outputs transparent black so the black background
  // shows through. Uses nearest on the rect bounds for a sharp edge.
  const imageShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uImage;
    uniform vec4 uMaskRect;

    void main () {
        vec2 m = step(uMaskRect.xy, vUv) * step(vUv, uMaskRect.xy + uMaskRect.zw);
        float inRect = m.x * m.y;
        // Map vUv from the mask rectangle into 0..1 for the image texture.
        vec2 imgUv = (vUv - uMaskRect.xy) / uMaskRect.zw;
        // The texture is uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL, so c.rgb
        // is already premultiplied by c.a. We just gate it by the rect mask.
        vec4 c = texture2D(uImage, imgUv);
        gl_FragColor = vec4(c.rgb * inRect, c.a * inRect);
    }
`
  );

  const checkerboardShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`
  );

  const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;
    uniform vec4 uMaskRect;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

        // Restrict fluid visibility to the uploaded image rectangle.
        // uMaskRect = (x, y, w, h) in UV space; outside → c=0, a=0.
        vec2 _m = step(uMaskRect.xy, vUv) * step(vUv, uMaskRect.xy + uMaskRect.zw);
        float inRect = _m.x * _m.y;
        c *= inRect;

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

  const bloomPrefilterShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`
  );

  const bloomBlurShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`
  );

  const bloomFinalShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`
  );

  const sunraysMaskShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`
  );

  const sunraysShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).a;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).a;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`
  );

  const splatShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`
  );

  const advectionShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
    #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
    ext.supportLinearFiltering ? null : ["MANUAL_FILTERING"]
  );

  const divergenceShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`
  );

  const curlShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`
  );

  const vorticityShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`
  );

  const pressureShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`
  );

  const gradientSubtractShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`
  );

  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
      gl.STATIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW
    );
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      if (clear) {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      // CHECK_FRAMEBUFFER_STATUS();
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  function CHECK_FRAMEBUFFER_STATUS() {
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
      console.trace("Framebuffer error: " + status);
  }

  let dye;
  let velocity;
  let divergence;
  let curl;
  let pressure;
  let bloom;
  let bloomFramebuffers = [];
  let sunrays;
  let sunraysTemp;

  let ditheringTexture = createTextureAsync("LDR_LLL1_0.png");

  const blurProgram = new Program(blurVertexShader, blurShader);
  const copyProgram = new Program(baseVertexShader, copyShader);
  const clearProgram = new Program(baseVertexShader, clearShader);
  const colorProgram = new Program(baseVertexShader, colorShader);
  const imageProgram = new Program(baseVertexShader, imageShader);
  const checkerboardProgram = new Program(baseVertexShader, checkerboardShader);
  const bloomPrefilterProgram = new Program(
    baseVertexShader,
    bloomPrefilterShader
  );
  const bloomBlurProgram = new Program(baseVertexShader, bloomBlurShader);
  const bloomFinalProgram = new Program(baseVertexShader, bloomFinalShader);
  const sunraysMaskProgram = new Program(baseVertexShader, sunraysMaskShader);
  const sunraysProgram = new Program(baseVertexShader, sunraysShader);
  const splatProgram = new Program(baseVertexShader, splatShader);
  const advectionProgram = new Program(baseVertexShader, advectionShader);
  const divergenceProgram = new Program(baseVertexShader, divergenceShader);
  const curlProgram = new Program(baseVertexShader, curlShader);
  const vorticityProgram = new Program(baseVertexShader, vorticityShader);
  const pressureProgram = new Program(baseVertexShader, pressureShader);
  const gradienSubtractProgram = new Program(
    baseVertexShader,
    gradientSubtractShader
  );

  const displayMaterial = new Material(baseVertexShader, displayShaderSource);

  function initFramebuffers() {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
      dye = createDoubleFBO(
        dyeRes.width,
        dyeRes.height,
        rgba.internalFormat,
        rgba.format,
        texType,
        filtering
      );
    else
      dye = resizeDoubleFBO(
        dye,
        dyeRes.width,
        dyeRes.height,
        rgba.internalFormat,
        rgba.format,
        texType,
        filtering
      );

    if (velocity == null)
      velocity = createDoubleFBO(
        simRes.width,
        simRes.height,
        rg.internalFormat,
        rg.format,
        texType,
        filtering
      );
    else
      velocity = resizeDoubleFBO(
        velocity,
        simRes.width,
        simRes.height,
        rg.internalFormat,
        rg.format,
        texType,
        filtering
      );

    divergence = createFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );
    curl = createFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );
    pressure = createDoubleFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );

    initBloomFramebuffers();
    initSunraysFramebuffers();
  }

  function initBloomFramebuffers() {
    let res = getResolution(config.BLOOM_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    bloom = createFBO(
      res.width,
      res.height,
      rgba.internalFormat,
      rgba.format,
      texType,
      filtering
    );

    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
      let width = res.width >> (i + 1);
      let height = res.height >> (i + 1);

      if (width < 2 || height < 2) break;

      let fbo = createFBO(
        width,
        height,
        rgba.internalFormat,
        rgba.format,
        texType,
        filtering
      );
      bloomFramebuffers.push(fbo);
    }
  }

  function initSunraysFramebuffers() {
    let res = getResolution(config.SUNRAYS_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays = createFBO(
      res.width,
      res.height,
      r.internalFormat,
      r.format,
      texType,
      filtering
    );
    sunraysTemp = createFBO(
      res.width,
      res.height,
      r.internalFormat,
      r.format,
      texType,
      filtering
    );
  }

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      w,
      h,
      0,
      format,
      type,
      null
    );

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX,
      texelSizeY,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
      width: w,
      height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() {
        return fbo1;
      },
      set read(value) {
        fbo1 = value;
      },
      get write() {
        return fbo2;
      },
      set write(value) {
        fbo2 = value;
      },
      swap() {
        let temp = fbo1;
        fbo1 = fbo2;
        fbo2 = temp;
      },
    };
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width == w && target.height == h) return target;
    target.read = resizeFBO(
      target.read,
      w,
      h,
      internalFormat,
      format,
      type,
      param
    );
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
  }

  function createTextureAsync(url) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255])
    );

    let obj = {
      texture,
      width: 1,
      height: 1,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };

    let image = new Image();
    image.onload = () => {
      obj.width = image.width;
      obj.height = image.height;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };
    image.src = url;

    return obj;
  }

  function updateKeywords() {
    let displayKeywords = [];
    if (config.SHADING) displayKeywords.push("SHADING");
    if (config.BLOOM) displayKeywords.push("BLOOM");
    if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
    displayMaterial.setKeywords(displayKeywords);
  }

  updateKeywords();
  initFramebuffers();
  multipleSplats(parseInt(Math.random() * 20) + 5);

  // Load the default top-layer overlay PNG (overlay.png). Loaded async; if the
  // file is missing it silently stays null and the layer is skipped.
  loadOverlayImage("overlay.png");

  let lastUpdateTime = Date.now();
  let colorUpdateTimer = 0.0;
  let autoSplatsTimer = 0.0;
  let edgeFlowT = 0.0; // progress 0..1 along the mask rect perimeter (edge mode)
  update();

  function update() {
    const dt = calcDeltaTime();
    if (resizeCanvas()) {
      initFramebuffers();
      updateMaskRect();
    }
    updateColors(dt);
    applyInputs();
    autoSplats(dt);
    if (!config.PAUSED) step(dt);
    render(null);
    if (isRecording) captureFrameForGif(dt);
    requestAnimationFrame(update);
  }

  function calcDeltaTime() {
    let now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666);
    lastUpdateTime = now;
    return dt;
  }

  function updateColors(dt) {
    if (!config.COLORFUL) return;

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
      colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
      pointers.forEach((p) => {
        p.color = generateColor();
      });
    }
  }

  function applyInputs() {
    if (splatStack.length > 0) multipleSplats(splatStack.pop());

    pointers.forEach((p) => {
      if (p.moved) {
        p.moved = false;
        splatPointer(p);
      }
    });
  }

  // Automatic continuous splats — drives the fluid by itself,
  // no mouse/touch needed. All settings come from config.json.
  function autoSplats(dt) {
    if (!config.AUTO_SPLATS) return;

    autoSplatsTimer += dt;
    if (autoSplatsTimer < config.AUTO_SPLATS_INTERVAL) return;
    autoSplatsTimer = 0.0;

    if (config.AUTO_SPLATS_MODE === "edge") {
      edgeFlowSplats();
    } else if (config.AUTO_SPLATS_MODE === "safe") {
      safeFlowSplats();
    } else {
      randomSplats();
    }
  }

  // Default mode: random splats scattered inside the mask rectangle.
  function randomSplats() {
    const force = config.AUTO_SPLATS_FORCE;
    for (let i = 0; i < config.AUTO_SPLATS_COUNT; i++) {
      const color = generateColor();
      // Keep the new splats inside the visible mask rectangle so fluid
      // only accumulates where it can actually be seen.
      const x = maskRect.x + Math.random() * maskRect.w;
      const y = maskRect.y + Math.random() * maskRect.h;
      const dx = force * (Math.random() - 0.5);
      const dy = force * (Math.random() - 0.5);
      splat(x, y, dx, dy, color);
    }
  }

  // Safe-zone mode: fluid only appears in two horizontal bands — a top band
  // and a bottom band of the image — leaving the middle blank.
  // SAFE_FLOW_TOP / SAFE_FLOW_BOTTOM are fractions (0..1) of the image height.
  function safeFlowSplats() {
    const force = config.AUTO_SPLATS_FORCE;
    const topFrac = config.SAFE_FLOW_TOP == null ? 0.15 : config.SAFE_FLOW_TOP;
    const botFrac = config.SAFE_FLOW_BOTTOM == null ? 0.30 : config.SAFE_FLOW_BOTTOM;
    // Top band: from the rectangle's top edge downward.
    // Bottom band: from the rectangle's bottom edge upward.
    // Note: UV space y points up, so maskRect.y is the bottom.
    const topY0 = maskRect.y + maskRect.h * (1 - topFrac);
    const topH = maskRect.h * topFrac;
    const botY0 = maskRect.y;
    const botH = maskRect.h * botFrac;
    for (let i = 0; i < config.AUTO_SPLATS_COUNT; i++) {
      const color = generateColor();
      // Pick the top or bottom band (weighted by their heights so both fill
      // proportionally).
      const useTop = Math.random() < topFrac / (topFrac + botFrac);
      const x = maskRect.x + Math.random() * maskRect.w;
      const y = useTop
        ? topY0 + Math.random() * topH
        : botY0 + Math.random() * botH;
      const dx = force * (Math.random() - 0.5);
      const dy = force * (Math.random() - 0.5);
      splat(x, y, dx, dy, color);
    }
  }

  // Edge mode: splats travel clockwise around the mask rectangle perimeter,
  // each pushed along the local tangent so the fluid forms a circulating band.
  function edgeFlowSplats() {
    const force = config.AUTO_SPLATS_FORCE;
    const count = config.AUTO_SPLATS_COUNT;
    // Advance the head of the train along the perimeter. EDGE_FLOW_SPEED is
    // the per-splat step in perimeter fraction; loop time ≈ INTERVAL/step.
    const step = config.EDGE_FLOW_SPEED == null ? 0.06 : config.EDGE_FLOW_SPEED;
    edgeFlowT = (edgeFlowT + step) % 1.0;
    for (let i = 0; i < count; i++) {
      // Spread the count splats evenly behind the head so they read as a
      // continuous streak hugging the edge.
      let t = (edgeFlowT - (i / count) * 0.08 + 1.0) % 1.0;
      const p = pointOnRectEdge(t, maskRect);
      const color = generateColor();
      splat(p.x, p.y, p.tx * force, p.ty * force, color);
    }
  }

  // Map a perimeter parameter t (0..1) to a point on the rectangle's edge in
  // UV space, returning the position and the clockwise tangent direction.
  // Screen-clockwise (viewer perspective): top→right, right→bottom,
  // bottom→left, left→top. In UV space (y up) that is: top edge +x, right
  // edge -y, bottom edge -x, left edge +y.
  function pointOnRectEdge(t, r) {
    const { x, y, w, h } = r;
    const perim = 2 * (w + h);
    let d = (t % 1) * perim;
    let px, py, tx, ty;
    if (d < w) {
      // top edge: left → right, tangent +x
      px = x + d; py = y + h; tx = 1; ty = 0;
    } else if ((d -= w) < h) {
      // right edge: top → bottom, tangent -y
      px = x + w; py = y + h - d; tx = 0; ty = -1;
    } else if ((d -= h) < w) {
      // bottom edge: right → left, tangent -x
      px = x + w - d; py = y; tx = -1; ty = 0;
    } else {
      // left edge: bottom → top, tangent +y
      d -= w; px = x; py = y + d; tx = 0; ty = 1;
    }
    return { x: px, y: py, tx, ty };
  }

  // ---- GIF recording ----

  // Build (or rebuild) the offscreen FBO used to capture frames.
  function getRecordFBO() {
    let res = getResolution(config.GIF_RESOLUTION || 384);
    if (
      !recordFBO ||
      recordFBO.width !== res.width ||
      recordFBO.height !== res.height
    ) {
      recordFBO = createFBO(
        res.width,
        res.height,
        ext.formatRGBA.internalFormat,
        ext.formatRGBA.format,
        ext.halfFloatTexType,
        gl.NEAREST
      );
    }
    return recordFBO;
  }

  // Called from update() every frame while recording. Paces capture to the
  // configured GIF fps so we don't grab more frames than needed.
  function captureFrameForGif(dt) {
    recordAccumulator += dt;
    if (recordAccumulator < recordInterval) return;
    recordAccumulator = 0.0;

    // Render the current simulation state into an offscreen FBO, then read it
    // back. This mirrors captureScreenshot() and avoids the
    // preserveDrawingBuffer:false gotcha.
    const target = getRecordFBO();
    render(target);

    // When an image is uploaded, crop the capture to its rectangle so the GIF
    // has no black borders. Otherwise capture the whole frame.
    const hasRect = maskTexture && config.MASK_ENABLED;
    const rw = hasRect
      ? Math.round(maskRect.w * target.width)
      : target.width;
    const rh = hasRect
      ? Math.round(maskRect.h * target.height)
      : target.height;
    // readPixels origin is bottom-left; maskRect is already bottom-left UV.
    const rx = hasRect ? Math.round(maskRect.x * target.width) : 0;
    const ry = hasRect ? Math.round(maskRect.y * target.height) : 0;

    let texture = framebufferToTextureRect(target, rx, ry, rw, rh);

    gifWorker.postMessage(
      { type: "frame", data: texture, width: rw, height: rh },
      [texture.buffer]
    );

    recordFrameCount++;
    if (recordFrameCount >= recordTargetFrames) finishRecording();
  }

  function startRecording() {
    if (isRecording) return;
    if (typeof Worker === "undefined") {
      alert("Your browser does not support Web Workers; cannot export GIF.");
      return;
    }
    const target = getRecordFBO();

    // Reset pacing/counters.
    const fps = config.GIF_FPS || 15;
    const duration = config.GIF_DURATION || 3;
    recordInterval = 1 / fps;
    recordAccumulator = 0.0;
    recordFrameCount = 0;
    recordTargetFrames = Math.max(1, Math.round(fps * duration));

    // Spin up the worker.
    gifWorker = new Worker("gif-worker.js");
    gifWorker.onmessage = (e) => {
      if (e.data.type === "done") {
        const blob = new Blob([new Uint8Array(e.data.data)], {
          type: "image/gif",
        });
        const url = URL.createObjectURL(blob);
        downloadURI("fluid.gif", url);
        URL.revokeObjectURL(url);
        const btn = document.getElementById("gifExportBtn");
        if (btn) {
          btn.textContent = "导出 GIF";
          btn.disabled = false;
        }
      }
    };
    gifWorker.onerror = (err) => {
      console.error("gif worker error", err);
      isRecording = false;
      const btn = document.getElementById("gifExportBtn");
      if (btn) {
        btn.textContent = "导出 GIF";
        btn.disabled = false;
      }
      alert("GIF 编码失败,请查看控制台。");
    };

    // The GIF frame size matches the image rectangle (cropped), or the whole
    // frame if no image is uploaded.
    const hasRect = maskTexture && config.MASK_ENABLED;
    const gifW = hasRect
      ? Math.round(maskRect.w * target.width)
      : target.width;
    const gifH = hasRect
      ? Math.round(maskRect.h * target.height)
      : target.height;

    gifWorker.postMessage({
      type: "start",
      width: gifW,
      height: gifH,
      fps: fps,
    });

    isRecording = true;
    const btn = document.getElementById("gifExportBtn");
    if (btn) {
      btn.textContent = "抓取画面…";
      btn.disabled = true;
    }
  }
  // Expose to the page so the HTML button can trigger recording.
  window.startFluidGif = startRecording;
  // Expose the live config so the controls panel can tweak values at runtime.
  window.fluidConfig = config;
  // Expose maskRect refresh so the "flow region" slider can resize it live.
  window.refreshFluidMask = updateMaskRect;

  function finishRecording() {
    if (!isRecording) return;
    isRecording = false;
    const btn = document.getElementById("gifExportBtn");
    if (btn) btn.textContent = "编码中…";
    gifWorker.postMessage({ type: "finish" });
  }

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(
      curlProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(
      vorticityProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(
      divergenceProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(
      pressureProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(
      gradienSubtractProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    gl.uniform1i(
      gradienSubtractProgram.uniforms.uPressure,
      pressure.read.attach(0)
    );
    gl.uniform1i(
      gradienSubtractProgram.uniforms.uVelocity,
      velocity.read.attach(1)
    );
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(
      advectionProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY
    );
    if (!ext.supportLinearFiltering)
      gl.uniform2f(
        advectionProgram.uniforms.dyeTexelSize,
        velocity.texelSizeX,
        velocity.texelSizeY
      );
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      config.VELOCITY_DISSIPATION
    );
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
      gl.uniform2f(
        advectionProgram.uniforms.dyeTexelSize,
        dye.texelSizeX,
        dye.texelSizeY
      );
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      config.DENSITY_DISSIPATION
    );
    blit(dye.write);
    dye.swap();
  }

  function render(target) {
    if (config.BLOOM) applyBloom(dye.read, bloom);
    if (config.SUNRAYS) {
      applySunrays(dye.read, dye.write, sunrays);
      blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
    }

    if (!config.TRANSPARENT)
      drawColor(target, normalizeColor(config.BACK_COLOR));
    if (target == null && config.TRANSPARENT) drawCheckerboard(target);
    if (config.MASK_ENABLED && maskTexture) drawImage(target);
    drawDisplay(target);
    // Top overlay only appears after the user uploads a layer-1 image.
    if (maskTexture) drawOverlay(target);
  }

  function drawColor(target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
  }

  // Draw the uploaded image into the mask rectangle, on top of the background
  // and beneath the fluid. Blend mode is already (ONE, ONE_MINUS_SRC_ALPHA)
  // from render(), so the image alpha is respected.
  function drawImage(target) {
    imageProgram.bind();
    gl.uniform1i(imageProgram.uniforms.uImage, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.uniform4f(
      imageProgram.uniforms.uMaskRect,
      maskRect.x,
      maskRect.y,
      maskRect.w,
      maskRect.h
    );
    blit(target);
  }

  // Draw the top-layer overlay PNG (with transparency) on top of everything.
  // Reuses imageShader so it is clipped to maskRect and respects alpha.
  function drawOverlay(target) {
    if (!overlayTexture) return;
    imageProgram.bind();
    gl.uniform1i(imageProgram.uniforms.uImage, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, overlayTexture);
    gl.uniform4f(
      imageProgram.uniforms.uMaskRect,
      maskRect.x,
      maskRect.y,
      maskRect.w,
      maskRect.h
    );
    blit(target);
  }

  // Load an image file (by URL) into a WebGL texture for the overlay layer.
  // Used both for the default overlay.png and for user-replaced images.
  function loadOverlayImage(url) {
    let img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      let tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      overlayTexture = tex;
    };
    img.onerror = () => {
      // Silently ignore — overlay is optional.
      console.warn("overlay image not found or failed to load:", url);
    };
    img.src = url;
  }

  function drawCheckerboard(target) {
    checkerboardProgram.bind();
    gl.uniform1f(
      checkerboardProgram.uniforms.aspectRatio,
      canvas.width / canvas.height
    );
    blit(target);
  }

  function drawDisplay(target) {
    let width = target == null ? gl.drawingBufferWidth : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    displayMaterial.bind();
    if (config.SHADING)
      gl.uniform2f(
        displayMaterial.uniforms.texelSize,
        1.0 / width,
        1.0 / height
      );
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
      gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
      gl.uniform1i(
        displayMaterial.uniforms.uDithering,
        ditheringTexture.attach(2)
      );
      let scale = getTextureScale(ditheringTexture, width, height);
      gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
      gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    // Pass the image mask rectangle (x, y, w, h) in UV space.
    gl.uniform4f(
      displayMaterial.uniforms.uMaskRect,
      maskRect.x,
      maskRect.y,
      maskRect.w,
      maskRect.h
    );
    blit(target);
  }

  function applyBloom(source, destination) {
    if (bloomFramebuffers.length < 2) return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(
      bloomPrefilterProgram.uniforms.threshold,
      config.BLOOM_THRESHOLD
    );
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
      let dest = bloomFramebuffers[i];
      gl.uniform2f(
        bloomBlurProgram.uniforms.texelSize,
        last.texelSizeX,
        last.texelSizeY
      );
      gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
      blit(dest);
      last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
      let baseTex = bloomFramebuffers[i];
      gl.uniform2f(
        bloomBlurProgram.uniforms.texelSize,
        last.texelSizeX,
        last.texelSizeY
      );
      gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
      gl.viewport(0, 0, baseTex.width, baseTex.height);
      blit(baseTex);
      last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(
      bloomFinalProgram.uniforms.texelSize,
      last.texelSizeX,
      last.texelSizeY
    );
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
  }

  function applySunrays(source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
  }

  function blur(target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
      gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
      gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
      blit(temp);

      gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
      gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
      blit(target);
    }
  }

  function splatPointer(pointer) {
    let dx = pointer.deltaX * config.SPLAT_FORCE;
    let dy = pointer.deltaY * config.SPLAT_FORCE;
    splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color);
  }

  function multipleSplats(amount) {
    for (let i = 0; i < amount; i++) {
      const color = generateColor();
      color.r *= 10.0;
      color.g *= 10.0;
      color.b *= 10.0;
      const x = Math.random();
      const y = Math.random();
      const dx = 1000 * (Math.random() - 0.5);
      const dy = 1000 * (Math.random() - 0.5);
      splat(x, y, dx, dy, color);
    }
  }

  function splat(x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(
      splatProgram.uniforms.aspectRatio,
      canvas.width / canvas.height
    );
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(
      splatProgram.uniforms.radius,
      correctRadius(config.SPLAT_RADIUS / 100.0)
    );
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  function correctRadius(radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) radius *= aspectRatio;
    return radius;
  }

  // Mouse Movements
  canvas.addEventListener("mousemove", (e) => {
    let pointer = pointers[0];
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);

    if (!pointer.down) {
      // Pointer is not down, so this is the start of a new move.
      // Call updatePointerDownData to set the initial position.
      updatePointerDownData(pointer, -1, posX, posY);
    }

    // Now, always update the pointer's movement data
    updatePointerMoveData(pointer, posX, posY);
  });

  window.addEventListener("mouseup", () => {
    updatePointerUpData(pointers[0]);
  });

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    while (touches.length >= pointers.length)
      pointers.push(new pointerPrototype());
    for (let i = 0; i < touches.length; i++) {
      let posX = scaleByPixelRatio(touches[i].pageX);
      let posY = scaleByPixelRatio(touches[i].pageY);
      updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
  });

  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const touches = e.targetTouches;
      for (let i = 0; i < touches.length; i++) {
        let pointer = pointers[i + 1];
        if (!pointer.down) continue;
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerMoveData(pointer, posX, posY);
      }
    },
    false
  );

  window.addEventListener("touchend", (e) => {
    const touches = e.changedTouches;
    for (let i = 0; i < touches.length; i++) {
      let pointer = pointers.find((p) => p.id == touches[i].identifier);
      if (pointer == null) continue;
      updatePointerUpData(pointer);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyP") config.PAUSED = !config.PAUSED;
    if (e.key === " ") splatStack.push(parseInt(Math.random() * 20) + 5);
  });

  // ---- Image mask: restrict fluid to the uploaded image rectangle ----

  // Recompute maskRect so the image is fit (contain) and centred in the canvas.
  // Coordinates are in display-shader UV space, where vUv=(0,0) is the
  // bottom-left and (1,1) is the top-right.
  function updateMaskRect() {
    if (maskImageWidth === 0 || maskImageHeight === 0 || !config.MASK_ENABLED) {
      maskRect = { x: 0, y: 0, w: 1, h: 1 };
      return;
    }
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / maskImageWidth, ch / maskImageHeight);
    // MASK_SCALE lets the user grow/shrink the active region relative to the
    // uploaded image size (1.0 = exact image size).
    const maskScale = config.MASK_SCALE == null ? 1.0 : config.MASK_SCALE;
    const drawW = maskImageWidth * scale * maskScale;
    const drawH = maskImageHeight * scale * maskScale;
    // Normalise to 0..1 in the same orientation as vUv (bottom-left origin).
    const w = drawW / cw;
    const h = drawH / ch;
    const x = (cw - drawW) / 2 / cw;
    const y = (ch - drawH) / 2 / ch;
    maskRect = { x, y, w, h };
  }

  // Hook the file input (added in index.html) to load an uploaded image.
  const maskInput = document.getElementById("maskFileInput");
  if (maskInput) {
    maskInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      // Reset branch (no file): clear the mask and image texture.
      if (!file) {
        maskImageWidth = 0;
        maskImageHeight = 0;
        maskTexture = null;
        updateMaskRect();
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          maskImageWidth = img.width;
          maskImageHeight = img.height;
          // Upload the image to a WebGL texture.
          // Flip Y so the image appears upright in UV space (bottom-left origin).
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          let tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img
          );
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          maskTexture = tex;
          updateMaskRect();
          // Kick the fluid so the new region fills in immediately.
          splatStack.push(parseInt(Math.random() * 20) + 5);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Top-layer overlay replacement button (#overlayFileInput added in index.html).
  const overlayInput = document.getElementById("overlayFileInput");
  if (overlayInput) {
    overlayInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          // Replace the previous overlay texture if any.
          if (overlayTexture) gl.deleteTexture(overlayTexture);
          let tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          overlayTexture = tex;
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function updatePointerDownData(pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.deltaX = 0;
    pointer.deltaY = 0;
    pointer.color = generateColor();
  }

  function updatePointerMoveData(pointer, posX, posY) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
    pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
    pointer.moved =
      Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
  }

  function updatePointerUpData(pointer) {
    pointer.down = false;
  }

  function correctDeltaX(delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio < 1) delta *= aspectRatio;
    return delta;
  }

  function correctDeltaY(delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) delta /= aspectRatio;
    return delta;
  }

  // Updated to allow single colors
  function generateColor() {
    if (config.RANDOM_COLORS) {
      let c = HSVtoRGB(Math.random(), 1.0, 1.0);
      c.r *= 0.15;
      c.g *= 0.15;
      c.b *= 0.15;
      return c;
    } else {
      let c = HSVtoRGB(config.SPLAT_HUE, 1.0, 1.0);
      c.r *= 0.15;
      c.g *= 0.15;
      c.b *= 0.15;
      return c;
    }
  }

  function HSVtoRGB(h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0:
        (r = v), (g = t), (b = p);
        break;
      case 1:
        (r = q), (g = v), (b = p);
        break;
      case 2:
        (r = p), (g = v), (b = t);
        break;
      case 3:
        (r = p), (g = q), (b = v);
        break;
      case 4:
        (r = t), (g = p), (b = v);
        break;
      case 5:
        (r = v), (g = p), (b = q);
        break;
    }

    return {
      r,
      g,
      b,
    };
  }

  function normalizeColor(input) {
    let output = {
      r: input.r / 255,
      g: input.g / 255,
      b: input.b / 255,
    };
    return output;
  }

  function wrap(value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return ((value - min) % range) + min;
  }

  function getResolution(resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
      return { width: max, height: min };
    else return { width: min, height: max };
  }

  function getTextureScale(texture, width, height) {
    return {
      x: width / texture.width,
      y: height / texture.height,
    };
  }

  function hashCode(s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }
}
