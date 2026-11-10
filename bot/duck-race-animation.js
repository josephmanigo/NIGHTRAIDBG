import { setImmediate as yieldFrame } from 'node:timers/promises'
import gifenc from 'gifenc'

const DETAILED_LANES = 16
const WIDTH = 480
const BANK = 62
const STRIPE = 390
const ink = {
  clear: '000000', sky: 'a7ddeb', haze: 'c5e8e8', cloud: 'fff6d9', sun: 'ffdf83',
  far: 'a2c9bc', hills: '83b6a4', leaves: '589880', pine: '397c72', grass: '8abe75',
  sand: 'f5d7a1', bank: 'c6946f', wave: '7de0d7', foam: 'd1f6e9', depth: '30999e',
  teal: '2e858e', rope: '56b6b3', navy: '224350', white: 'fff7df', brown: '81432a',
  shadow: 'df902e', yellow: 'ffce42', light: 'ffe979', shine: 'fff3a9', bill: 'f78a31',
  billDark: 'd25b2e', cheek: 'ffad57', eye: '332e37', water1: '57c7c3', water2: '52c2bf',
  water3: '4bbab9', water4: '44b2b3', red: 'e6604d', blue: '3773a3', violet: '9666ae',
  green: '419478', coral: 'd9667c', amber: 'b16e35', mint: '379a9c', plum: '916579',
  indigo: '646cb0', lime: '7d913c', ocean: '3b8499', rose: 'ae565e',
}
const color = Object.fromEntries(Object.keys(ink).map((name, index) => [name, index]))
const palette = Object.values(ink).map(hex => [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)))
const bibs = 'red blue violet green coral amber mint plum indigo lime ocean rose'.split(' ').map(name => color[name])
const digits = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111',
]
const letters = {
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14],
  D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [14,17,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [14,4,4,4,4,4,14],
  J: [7,2,2,2,2,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,25,25,21,19,19,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17],
  S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14],
  V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,27,17], X: [17,17,10,4,10,17,17],
  Y: [17,17,10,4,4,4,4], Z: [31,1,2,4,8,16,31],
  '-': [0,0,0,14,0,0,0], '.': [0,0,0,0,0,0,4], '_': [0,0,0,0,0,0,31],
}

class Bitmap {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.pixels = new Uint8Array(width * height)
  }

  rect(x, y, w, h, fill) {
    const left = Math.max(0, Math.round(x)), right = Math.min(this.width, Math.round(x + w))
    if (right <= left) return
    const bottom = Math.min(this.height, Math.round(y + h))
    for (let row = Math.max(0, Math.round(y)); row < bottom; row++) {
      this.pixels.fill(fill, row * this.width + left, row * this.width + right)
    }
  }

  ellipse(x, y, rx, ry, fill) {
    for (let dy = -ry; dy <= ry; dy++) {
      const dx = Math.floor(rx * Math.sqrt(1 - (dy / ry) ** 2))
      this.rect(x - dx, y + dy, dx * 2 + 1, 1, fill)
    }
  }

  polygon(points, fill) {
    const ys = points.map(p => p[1])
    for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
      const hits = []
      for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length]
        const scan = y + 0.5
        if ((y0 <= scan && scan < y1) || (y1 <= scan && scan < y0)) {
          hits.push(x0 + (scan - y0) * (x1 - x0) / (y1 - y0))
        }
      }
      hits.sort((a, b) => a - b)
      for (let i = 0; i + 1 < hits.length; i += 2) this.rect(hits[i], y, hits[i + 1] - hits[i], 1, fill)
    }
  }

  number(value, cx, cy, scale) {
    const text = String(value)
    const left = cx - (text.length * 4 - 1) * scale / 2
    for (let i = 0; i < text.length; i++) {
      const glyph = digits[Number(text[i])]
      for (let j = 0; j < glyph.length; j++) {
        if (glyph[j] === '1') this.rect(left + (4 * i + j % 3) * scale, cy - 2.5 * scale + Math.floor(j / 3) * scale, scale, scale, color.white)
      }
    }
  }

  name(label, x, y, limit = 8) {
    const nickname = String(label ?? '').replace(/^[a-z0-9]{1,10}\s*[•·∙⦁●・]\s*/i, '')
    const latin = nickname.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    const text = latin.replace(/[^A-Z0-9_.-]+/g, ' ').trim().slice(0, limit)
    for (const ch of text) {
      if (letters[ch]) {
        letters[ch].forEach((bits, row) => {
          for (let col = 0; col < 5; col++) {
            if (bits & (16 >> col)) this.rect(x + col * 2, y + row * 2, 2, 2, color.white)
          }
        })
      } else if (/[0-9]/.test(ch)) this.number(ch, x + 5, y + 7, 2)
      x += 12
    }
  }
}

function makeDuck(lane) {
  const duck = new Bitmap(48, 32)
  const c = color
  const bibColor = bibs[lane % bibs.length]
  // A rubber body, upturned tail, raised round head and two-part orange bill.
  duck.polygon([[1, 13], [11, 18], [22, 19], [30, 23], [22, 28], [7, 25], [3, 20]], c.brown)
  duck.polygon([[3, 15], [13, 19], [22, 20], [21, 26], [7, 24]], c.yellow)
  duck.ellipse(21, 22, 17, 9, c.brown)
  duck.ellipse(21, 22, 15, 8, c.shadow)
  duck.ellipse(22, 20, 15, 7, c.yellow)
  duck.ellipse(33, 11, 10, 11, c.brown)
  duck.ellipse(33, 11, 9, 10, c.yellow)
  duck.ellipse(32, 8, 7, 6, c.light)
  duck.ellipse(30, 5, 4, 2, c.shine)
  duck.ellipse(32, 18, 7, 4, c.yellow)
  duck.ellipse(34, 14, 3, 2, c.cheek)
  duck.ellipse(36, 9, 2, 3, c.eye)
  duck.rect(36, 7, 1, 1, c.white)
  duck.polygon([[39, 13], [47, 11], [48, 15], [44, 19], [39, 18]], c.brown)
  duck.polygon([[40, 14], [47, 12], [46, 15], [40, 17]], c.bill)
  duck.rect(41, 17, 4, 1, c.billDark)
  duck.ellipse(17, 21, 9, 5, c.shadow)
  duck.ellipse(17, 20, 8, 4, c.light)
  duck.rect(12, 18, 5, 1, c.shine)
  duck.ellipse(25, 22, 7, 6, c.brown)
  duck.ellipse(25, 22, 6, 5, bibColor)
  if (lane < 999) duck.number(lane + 1, 25, 22, 1)
  if (lane % 4 === 1) {
    duck.ellipse(32, 3, 7, 3, bibColor)
    duck.rect(27, 4, 16, 2, c.navy)
  } else if (lane % 4 === 2) {
    duck.rect(25, 4, 14, 2, bibColor)
    duck.polygon([[26, 4], [20, 2], [22, 7], [26, 6]], bibColor)
  } else if (lane % 4 === 3) {
    duck.polygon([[25, 1], [37, 1], [36, 6], [27, 6]], c.white)
    duck.rect(26, 5, 12, 2, c.navy)
  }
  return duck
}

function makeRiver(lanes, laneHeight) {
  const count = lanes.length
  const river = new Bitmap(WIDTH, BANK + count * laneHeight + 6)
  const c = color
  river.pixels.fill(c.sky)
  river.rect(0, 24, WIDTH, 26, c.haze)
  river.ellipse(290, 20, 12, 12, c.sun)
  for (const [x, y] of [[28, 13], [148, 7], [319, 13], [431, 9]]) {
    river.ellipse(x, y + 2, 13, 3, c.cloud)
    river.ellipse(x + 9, y, 8, 5, c.cloud)
    river.ellipse(x + 18, y + 2, 10, 3, c.cloud)
  }
  for (const [level, height, steps, fill] of [[43, 14, 89, c.far], [49, 10, 63, c.hills]]) {
    for (let x = 0; x < WIDTH; x++) {
      const y = Math.round(level - height * Math.cos(x / steps) - 4 * Math.sin(x / 23))
      river.rect(x, y, 1, BANK - y, fill)
    }
  }
  for (let i = 0; i < 44; i++) {
    const x = (i * 113) % WIDTH, h = 5 + (i * 11) % 11
    river.polygon([[x - 5, 54], [x, 53 - h], [x + 7, 54]], i % 3 ? c.leaves : c.pine)
  }
  river.rect(0, 53, WIDTH, 3, c.grass)
  river.rect(0, 56, WIDTH, 3, c.sand)
  river.rect(0, 59, WIDTH, 3, c.bank)
  // Boathouse and jetty on the far bank.
  river.rect(64, 40, 22, 14, c.sand)
  river.polygon([[60, 41], [74, 31], [89, 41]], c.red)
  river.rect(68, 44, 5, 6, c.pine)
  river.rect(77, 44, 6, 10, c.bank)
  river.rect(87, 53, 30, 2, c.brown)
  river.rect(93, 55, 2, 5, c.bank)
  river.rect(113, 51, 2, 9, c.bank)
  const water = [c.water1, c.water2, c.water3, c.water4]
  for (let lane = 0; lane < count; lane++) {
    const top = BANK + lane * laneHeight, mid = top + laneHeight / 2
    river.rect(0, top, WIDTH, laneHeight, water[Math.min(3, Math.floor(4 * lane / count))])
    for (let i = 0; i < 21; i++) {
      const x = 23 + (i * 83 + lane * 47) % (WIDTH - 26)
      const y = top + 3 + (i * 19 + lane * 13) % (laneHeight - 6)
      river.rect(x, y, 4 + (i * 17) % 10, 1, i % 3 ? c.rope : c.wave)
    }
    if (lane) {
      river.rect(0, top, WIDTH, 1, c.rope)
      for (let x = 37; x < WIDTH; x += 77) {
        river.rect(x, top - 1, 6, 2, c.foam)
      }
    }
    river.rect(4, mid - 10, 120, 21, c.teal)
    const bib = lanes[lane].bib ?? lane + 1
    const width = Math.max(19, String(bib).length * 8 + 5)
    river.rect(4, mid - 10, width, 21, c.navy)
    river.rect(4, mid - 10, 3, 21, bibs[(bib - 1) % bibs.length])
    river.number(bib, 6 + width / 2, mid, 2)
    const nameX = width + 8
    river.name(lanes[lane].name, nameX, Math.round(mid - 7), Math.floor((124 - nameX) / 12))
  }
  const bottom = BANK + count * laneHeight
  river.rect(0, bottom, WIDTH, 6, c.teal)
  for (let y = BANK; y < bottom; y += 5) {
    const alternate = Math.floor((y - BANK) / 5) % 2
    river.rect(STRIPE, y, 5, Math.min(5, bottom - y), alternate ? c.navy : c.white)
    river.rect(STRIPE + 5, y, 5, Math.min(5, bottom - y), alternate ? c.white : c.navy)
  }
  if (count) drawFinishFlag(river, STRIPE)
  return river
}

function drawFinishFlag(river, stripe) {
  const c = color
  river.rect(stripe - 1, 27, 3, BANK - 26, c.navy)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      river.rect(stripe + 2 + col * 4, 29 + row * 4 + Math.round(2 * Math.sin(col)), 4, 4, (row + col) % 2 ? c.white : c.navy)
    }
  }
}

// Everyone has a fixed lane. Large fields use adjacent columns of lanes in the same image.
function raceScene(lanes, density = 1) {
  const count = lanes.length
  if (count <= DETAILED_LANES) {
    const height = Math.max(25, Math.min(76, Math.floor(242 / count)))
    const scale = Math.min(1.55, (height - 6) / 32)
    const width = Math.round(48 * scale)
    return {
      river: makeRiver(lanes, height),
      tracks: lanes.map((duck, i) => ({
        sprite: makeDuck((duck.bib ?? i + 1) - 1), scale,
        start: 129 + width, stripe: STRIPE, end: STRIPE + 11 + width,
        baseline: Math.round(BANK + height * (i + 0.5) + 16 * scale),
      })),
    }
  }

  const columns = Math.ceil(Math.sqrt(count / 12))
  const rows = Math.ceil(count / columns)
  const w = Math.max(14, Math.floor(768 / columns / density))
  const heightBudget = Math.max(600, Math.min(1600, count * 1.4))
  const h = Math.max(3, Math.min(40, Math.floor(heightBudget / rows / density)))
  const river = new Bitmap(w * columns, BANK + rows * h + 4)
  const scenery = makeRiver([], 0)
  for (let y = 0; y < BANK; y++) {
    for (let x = 0; x < river.width; x++) river.pixels[y * river.width + x] = scenery.pixels[y * WIDTH + x % WIDTH]
  }
  river.rect(0, BANK, river.width, river.height - BANK, color.water2)
  const scale = Math.min(1, (h - 1) / 35, w / 180)
  const duckWidth = Math.max(3, Math.round(48 * scale))
  const smallSprites = Array.from({ length: bibs.length }, (_, i) => makeDuck(i))
  const tracks = lanes.map((duck, index) => {
    const x = w * Math.floor(index / rows), y = BANK + h * (index % rows)
    const bib = duck.bib ?? index + 1
    const stripeWidth = Math.max(1, Math.min(4, Math.floor(h / 5)))
    const stripe = x + w - duckWidth - stripeWidth * 2 - 2
    const tag = h >= 19 && w >= 220 ? 111 : h >= 9 && w >= 65 ? Math.max(19, String(bib).length * 4 + 6) : 1
    river.rect(x, y, w - 1, h - 1, index % rows % 2 ? color.water1 : color.water2)
    if (index % rows === 0 && w >= 100) drawFinishFlag(river, stripe)
    if (tag > 1) {
      river.rect(x + 1, y + 1, tag - 1, h - 2, color.teal)
      river.number(bib, x + (tag >= 111 ? 13 : tag / 2), y + h / 2, 1)
      if (tag >= 111) river.name(duck.name, x + 28, Math.round(y + h / 2 - 7), 6)
    }
    for (let yy = 0; yy < h; yy += stripeWidth) {
      const first = Math.floor((y + yy - BANK) / stripeWidth) % 2
      river.rect(stripe, y + yy, stripeWidth, Math.min(h - yy, stripeWidth), first ? color.white : color.navy)
      river.rect(stripe + stripeWidth, y + yy, stripeWidth, Math.min(h - yy, stripeWidth), first ? color.navy : color.white)
    }
    return {
      sprite: h >= 20 ? makeDuck(bib - 1) : smallSprites[(bib - 1) % smallSprites.length], scale,
      start: x + tag + duckWidth + 1, stripe, end: x + w - 1,
      baseline: Math.round(y + h / 2 + Math.max(2, 32 * scale) / 2),
    }
  })
  return { river, tracks }
}

function drawSwimmer(river, track, nose, time, out) {
  const { sprite, scale, baseline } = track
  const width = Math.max(3, Math.round(sprite.width * scale))
  const height = Math.max(2, Math.round(sprite.height * scale))
  const left = Math.round(nose - width)
  const bob = Math.round(Math.sin(time * 2 * Math.PI) * Math.min(2, 1.4 * scale))
  const top = baseline - height + bob
  if (height <= 6) {
    // A tiny side-on duck still has a body, raised head and bill at crowd scale.
    river.rect(left, top + Math.floor(height / 2), width - 1, Math.ceil(height / 2), out ? color.teal : color.yellow)
    river.rect(left + width - 3, top, 2, Math.ceil(height / 2), out ? color.teal : color.light)
    river.rect(left + width - 1, top + Math.floor(height / 3), 1, 1, out ? color.navy : color.bill)
    return
  }
  if (!out && scale >= 0.35) {
    const wake = Math.round(2 * scale * Math.sin(time * 2 * Math.PI))
    river.rect(left - Math.round(9 * scale) + wake, baseline, Math.round(8 * scale), 1, color.foam)
  }
  for (let y = 0; y < height; y++) {
    const sourceRow = Math.floor(y * sprite.height / height) * sprite.width
    const destRow = (top + y) * river.width + left
    for (let x = 0; x < width; x++) {
      const fill = sprite.pixels[sourceRow + Math.floor(x * sprite.width / width)]
      if (fill) river.pixels[destRow + x] = out ? (fill === color.brown || fill === color.eye ? color.navy : color.hills) : fill
    }
  }
}

export async function renderDuckRaceGif({ lanes, frames, finish = 12, replay = false, durationMs = 2500 }) {
  if (!lanes.length || !frames.length || !(finish > 0)
    || frames.some(frame => frame.positions.length !== lanes.length)) throw new RangeError('Invalid duck race frames')
  let density = 1
  let scene = raceScene(lanes)
  let legs = Math.max(1, frames.length - 1)
  const runtime = replay ? Math.min(15_000, legs * 1500) : durationMs
  const targetFrames = Math.max(2, Math.min(100, Math.round(runtime / 110), Math.floor(26_000_000 / scene.river.pixels.length)))
  let steps = Math.max(1, Math.floor(targetFrames / legs))
  for (;;) {
    const { river, tracks } = scene
    const background = river.pixels.slice()
    const gif = gifenc.GIFEncoder()
    encode: for (let leg = 0; leg < legs; leg++) {
      const from = frames[leg], to = frames[Math.min(leg + 1, frames.length - 1)]
      for (let step = leg ? 1 : 0; step <= steps; step++) {
        const t = step / steps
        river.pixels.set(background)
        for (let lane = 0; lane < lanes.length; lane++) {
          const previous = from.positions[lane], next = to.positions[lane]
          if (next == null && (previous == null || t === 1)) continue
          const track = tracks[lane]
          const at = value => track.start + (track.stripe - track.start) * Math.min(1, Math.max(0, value / finish))
          const fromX = from.winner === lane ? track.end : at(previous ?? next)
          // Meet the stripe at the timed finish; the replay also shows the winner clearing it.
          const toX = to.winner === lane ? (replay ? track.end : track.stripe + 1) : at(next ?? previous)
          const out = from.out?.[lane] || (t === 1 && to.out?.[lane])
          drawSwimmer(river, track, fromX + (toX - fromX) * t, (leg + t) * 2 + lane / 4, out)
        }
        const first = leg === 0 && step === 0
        const last = leg === legs - 1 && step === steps
        gif.writeFrame(river.pixels, river.width, river.height, {
          palette: first ? palette : undefined, repeat: replay ? 0 : -1,
          delay: last && replay ? 1000 : Math.max(20, Math.round(runtime / (steps * legs))), colorDepth: 6,
        })
        if (gif.bytesView().length >= 8 * 1024 * 1024) break encode
        await yieldFrame()
      }
    }
    gif.finish()
    const bytes = gif.bytesView()
    if (bytes.length <= 8 * 1024 * 1024) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    river.pixels.set(background)
    if (steps > 1) {
      steps = Math.max(1, Math.floor(steps / 2))
    } else if (frames.length > 2) {
      frames = frames.filter((_, i) => i % 2 === 0 || i === frames.length - 1)
      legs = frames.length - 1
    } else {
      // Preserve the entire field when the two endpoint images alone exceed the upload budget.
      density *= 2
      const smaller = raceScene(lanes, density)
      if (smaller.river.pixels.length >= background.length) throw new RangeError('Race image exceeds the Discord attachment budget')
      scene = smaller
    }
  }
}
