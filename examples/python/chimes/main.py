import asyncio, math, random, js
from pyodide.ffi import create_proxy
ctx = canvas.getContext("2d")
W, H = canvas.width, canvas.height
audio_ctx = js.AudioContext.new()
def beep(freq=440):
    try:
        if audio_ctx.state == "suspended":
            audio_ctx.resume()
        osc = audio_ctx.createOscillator()
        gain = audio_ctx.createGain()
        osc.type = "sine"
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.06, audio_ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, audio_ctx.currentTime + 0.12)
        osc.connect(gain)
        gain.connect(audio_ctx.destination)
        osc.start()
        osc.stop(audio_ctx.currentTime + 0.12)
    except Exception:
        pass
balls = [
    {"x": random.uniform(80, W-80), "y": random.uniform(80, H-80),
     "vx": random.choice([-5, -4, 4, 5]), "vy": random.choice([-5, -4, 4, 5]),
     "r": random.randint(16, 26), "hue": i * 55, "freq": 280 + i * 70}
    for i in range(6)
]
print("Python Neon Physics running! Bounces trigger WebAudio chimes.")
while True:
    ctx.fillStyle = "rgba(10, 10, 18, 0.35)"
    ctx.fillRect(0, 0, W, H)
    for b in balls:
        b["x"] += b["vx"]
        b["y"] += b["vy"]
        if b["x"] - b["r"] < 0 or b["x"] + b["r"] > W:
            b["vx"] *= -1
            beep(b["freq"])
        if b["y"] - b["r"] < 0 or b["y"] + b["r"] > H:
            b["vy"] *= -1
            beep(b["freq"] * 1.25)
        ctx.beginPath()
        ctx.arc(b["x"], b["y"], b["r"], 0, math.pi * 2)
        ctx.fillStyle = f"hsl({b['hue']}, 90%, 60%)"
        ctx.fill()
    await asyncio.sleep(1 / 60)