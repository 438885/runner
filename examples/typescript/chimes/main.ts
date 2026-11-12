interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
  freq: number;
}

document.body.className = "m-0 bg-black text-white overflow-hidden w-screen h-screen";

const canvas = document.createElement("canvas");
canvas.id = "canvas";
canvas.width = 960;
canvas.height = 600;
canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;outline:0";

const overlay = document.createElement("pre");
overlay.style.cssText = "position:fixed;inset:0;padding:12px;font:14px monospace;overflow:auto;pointer-events:none;text-shadow:0 1px 2px #000;margin:0";

document.body.replaceChildren(canvas, overlay);

const ctx = canvas.getContext("2d")!;
const W = canvas.width;
const H = canvas.height;

const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
const audioCtx = new AudioCtx();

window.addEventListener("pointerdown", () => {
  if (audioCtx.state === "suspended") audioCtx.resume();
});

function beep(freq: number = 440): void {
  try {
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // Ignore audio context restrictions
  }
}

const speedChoices = [-5, -4, 4, 5];
const randomUniform = (min: number, max: number): number => min + Math.random() * (max - min);
const randomInt = (min: number, max: number): number => Math.floor(randomUniform(min, max + 1));
const randomChoice = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const balls: Ball[] = Array.from({ length: 6 }, (_, i) => ({
  x: randomUniform(80, W - 80),
  y: randomUniform(80, H - 80),
  vx: randomChoice(speedChoices),
  vy: randomChoice(speedChoices),
  r: randomInt(16, 26),
  hue: i * 55,
  freq: 280 + i * 70
}));

const msg = "TypeScript Neon Physics running! Bounces trigger WebAudio chimes.";
overlay.textContent = msg + "\\n";
console.log(msg);

function loop(): void {
  ctx.fillStyle = "rgba(10, 10, 18, 0.35)";
  ctx.fillRect(0, 0, W, H);

  for (const b of balls) {
    b.x += b.vx;
    b.y += b.vy;

    if (b.x - b.r < 0 || b.x + b.r > W) {
      b.vx *= -1;
      beep(b.freq);
    }
    if (b.y - b.r < 0 || b.y + b.r > H) {
      b.vy *= -1;
      beep(b.freq * 1.25);
    }

    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(\${b.hue}, 90%, 60%)`;
    ctx.fill();
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);