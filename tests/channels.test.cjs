const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const base = path.resolve(__dirname, "../app/static");
const env = {
  window: {},
  document: {},
  performance,
  innerWidth: 1000,
  innerHeight: 900,
  screen: { availWidth: 1000, availHeight: 900 },
};
env.window.innerWidth = 1000;
env.window.innerHeight = 900;
vm.runInNewContext(fs.readFileSync(path.join(base, "edge-ai.js"), "utf8"), env);
const proto = env.window.ExamEdge.prototype;

test("phone requires consistent cell-phone boxes on distinct frames", () => {
  let det,
    events = [];
  const engine = Object.assign(Object.create(proto), {
    video: { currentTime: 0, videoWidth: 640, videoHeight: 480 },
    object: { detectForVideo: () => ({ detections: [det] }) },
    counts: {},
    emit: (channel, type) => events.push(type),
  });
  function frame(label, score, x = 30, advance = true) {
    if (advance) engine.video.currentTime += 0.45;
    det = {
      categories: [{ categoryName: label, score }],
      boundingBox: { originX: x, originY: 30, width: 50, height: 90 },
    };
    engine.objectCheck(engine.video.currentTime * 1000);
  }
  for (let i = 0; i < 4; i++) frame("cell phone", 0.29);
  for (let i = 0; i < 4; i++) frame("remote", 0.95);
  frame("cell phone", 0.8);
  frame("cell phone", 0.8, 30, false);
  frame("cell phone", 0.8, 300);
  assert.deepEqual(events, []);
  frame("cell phone", 0.8, 300);
  frame("cell phone", 0.8, 300);
  assert.deepEqual(events, ["phone_detected"]);
});
test("one continuous fullscreen exit produces one event", () => {
  let events = [];
  const engine = { lock() {}, emit: (ch, t) => events.push(t) };
  env.document.fullscreenElement = null;
  proto.checkScreen.call(engine);
  proto.checkScreen.call(engine);
  env.document.fullscreenElement = {};
  proto.checkScreen.call(engine);
  env.document.fullscreenElement = null;
  proto.checkScreen.call(engine);
  assert.deepEqual(events, ["fullscreen_exit", "fullscreen_exit"]);
});

function audioRun(samples) {
  let Processor;
  const packets = [],
    events = [];
  const context = {
    sampleRate: 48000,
    currentTime: 0,
    WebAssembly,
    registerProcessor: (_, p) => (Processor = p),
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (p) => packets.push(p) };
      }
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(base, "speech-monitor.js"), "utf8"),
    context,
  );
  const module = new WebAssembly.Module(
    fs.readFileSync(path.join(base, "vendor/libfvad/libfvad.wasm")),
  );
  const node = new Processor({ processorOptions: { module, mode: 2 } });
  for (let i = 0; i < samples.length; i += 128) {
    context.currentTime = i / 48000;
    node.process([[samples.subarray(i, i + 128)]]);
  }
  const state = {
    audio: {},
    flags: [],
    burst: 0,
    emit: (ch, t) => events.push(t),
  };
  for (const packet of packets) {
    state.audio.currentTime = packet.at / 1000;
    proto.audioCheck.call(state, packet);
  }
  assert.equal(packets.length, Math.floor(samples.length / 4800));
  return events;
}
test("silence and isolated clicks do not raise audio observations", () => {
  const samples = new Float32Array(48000 * 5);
  assert.deepEqual(audioRun(samples), []);
  for (let i = 0; i < samples.length; i += 24000) samples[i] = 0.7;
  assert.deepEqual(audioRun(samples), []);
});
test(
  "recorded speech at original and reduced level",
  { skip: !process.env.VAD_TEST_WAV },
  () => {
    const wav = fs.readFileSync(process.env.VAD_TEST_WAV);
    const start = wav.indexOf("data") + 8;
    const samples = Float32Array.from(
      { length: (wav.length - start) / 2 },
      (_, i) => wav.readInt16LE(start + 2 * i) / 32768,
    );
    for (const gain of [1, 0.1]) {
      assert.ok(
        audioRun(samples.map((v) => v * gain)).includes("sustained_speech"),
      );
    }
  },
);

test("a single face returning in profile only logs a sustained head turn",()=>{
  const events=[];
  const video={currentTime:1,videoWidth:640,videoHeight:480};
  const r={faceLandmarks:[],facialTransformationMatrixes:[{data:[.707,0,.707,0,0,1,0,0,0,0,.707]}]};
  const engine=Object.assign(Object.create(proto),{video,counts:{},base:{yaw:0,pitch:0},face:{detectForVideo:()=>r},emit:(ch,t)=>events.push(t)});
  engine.faceCheck(0);
  r.faceLandmarks=[[{x:.3,y:.2},{x:.5,y:.6}]];
  for(let i=0;i<5;i++){
    video.currentTime+=.25;
    engine.faceCheck(700+i*250);
  }
  assert.deepEqual(events,["head_turn"]);
});
