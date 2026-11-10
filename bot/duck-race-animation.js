import { setImmediate as yieldFrame } from 'node:timers/promises'
import gifenc from 'gifenc'
import { readFileSync } from 'node:fs'

const DETAILED_LANES = 16
const WIDTH = 480
const BANK = 115
const STRIPE = 390
const ink = {
  clear: '000000', sky: '17121f', dusk: '35202e', horizon: '67313d', moon: 'f77866',
  moonLight: 'ffad86', flare: 'ffe4ce', far: '432936', hills: '394657', iron: '1b1d26',
  steel: '454354', ink: '101116', lamp: 'd87c78', red: 'e3262e', redDeep: 'a81b21',
  water1: '253b4b', water2: '223745', water3: '20333f', water4: '1d303b',
  wave: '4e6b79', foam: 'a0bbc1', rope: '354c59', tag: '171a22', navy: '10141b',
  white: 'faf4e9', brown: '713d2e', shadow: 'd58c33', yellow: 'ffcd50', light: 'ffe980',
  shine: 'fff1bd', bill: 'ffa13b', billDark: 'd65a2e', cheek: 'ffaf59', eye: '27252d',
  blue: '477eb0', violet: '9767ac', green: '367561', coral: 'bf4d64', amber: 'aa652d',
  mint: '3e7c80', plum: '985978', indigo: '6b70ab', lime: '718342', ocean: '366e8c', rose: 'a94755',
}
const color = Object.fromEntries(Object.keys(ink).map((name, index) => [name, index]))
// The six supplied spectator photos share one indexed sprite sheet. Zero is transparent.
const audience = JSON.parse(readFileSync(new URL('./duck-race-audience.json', import.meta.url), 'utf8'))
const audiencePixels = Buffer.from(audience.pixels, 'base64')
const audiencePaletteStart = Object.keys(ink).length
const palette = [...Object.values(ink), ...audience.palette].map(hex =>
  [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)))
const bibs = 'red blue violet green coral amber mint plum indigo lime ocean rose'.split(' ').map(name => color[name])
// Small indexed version of public/images/nightraid-favicon.png, prepared once for the GIF palette.
const crest = readFileSync(new URL('./duck-race-crest.txt', import.meta.url), 'utf8').trim().split(/\r?\n/)
const crestColors = { o: color.ink, x: color.steel, '+': color.redDeep, '#': color.red }
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

  line(x, y, endX, endY, width, fill) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(endX - x), Math.abs(endY - y))))
    for (let i = 0; i <= steps; i++) {
      this.rect(x + (endX - x) * i / steps, y + (endY - y) * i / steps, width, width, fill)
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

  name(label, x, y, limit = 8, scale = 2, fill = color.white) {
    const nickname = String(label ?? '').replace(/^[a-z0-9]{1,10}\s*[•·∙⦁●・]\s*/i, '')
    const latin = nickname.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    const text = latin.replace(/[^A-Z0-9_.-]+/g, ' ').trim().slice(0, limit)
    for (const ch of text) {
      if (letters[ch]) {
        letters[ch].forEach((bits, row) => {
          for (let col = 0; col < 5; col++) {
            if (bits & (16 >> col)) this.rect(x + col * scale, y + row * scale, scale, scale, fill)
          }
        })
      } else if (/[0-9]/.test(ch)) this.number(ch, x + 2.5 * scale, y + 3.5 * scale, scale)
      x += 6 * scale
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
  duck.polygon([[24, 15], [31, 18], [38, 16], [36, 19], [29, 21], [22, 17]], c.red)
  duck.polygon([[23, 16], [29, 19], [20, 20], [16, 17]], c.redDeep)
  duck.ellipse(25, 22, 7, 6, c.navy)
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

const cheerRates = [0.85, 1.1, 0.72, 1.03, 0.92, 0.68]
const seatWidth = audience.width / cheerRates.length
const poseCount = 16

function makeCheerPose(seat, phase) {
  const pose = new Bitmap(seatWidth, audience.height + 6)
  const beat = Math.sin(phase), swing = Math.cos(phase)
  const lean = (seat % 2 ? 1 : -1) * 3.5 * swing
  const stretch = 1 + 0.1 * beat
  const baseline = pose.height - 1
  // Pivot at the waist so a face can lean into a cheer while its body stays behind the rail.
  for (let y = 0; y < pose.height; y++) {
    const rise = (baseline - y) / stretch
    const sourceY = audience.height - 1 - Math.round(rise)
    if (sourceY < 0 || sourceY >= audience.height) continue
    const shift = Math.round(lean * rise / audience.height)
    const sourceRow = sourceY * audience.width + seat * seatWidth
    for (let x = Math.max(0, -shift); x < Math.min(seatWidth, seatWidth - shift); x++) {
      const pixel = audiencePixels[sourceRow + x]
      if (pixel) pose.pixels[y * seatWidth + x + shift] = audiencePaletteStart + pixel - 1
    }
  }

  function anchor(x, y) {
    const rise = audience.height - 1 - y
    return [Math.round(x + lean * rise / audience.height), Math.round(baseline - stretch * rise)]
  }
  function photoColor(x, y) {
    return audiencePaletteStart + audiencePixels[y * audience.width + seat * seatWidth + x] - 1
  }
  const c = color
  if (seat === 0 || seat === 4) {
    const side = seat === 0 ? 1 : -1
    const [x, y] = anchor(seat === 0 ? 5 : 13, 36)
    const tipX = x + 2 + 5 * swing, tipY = y - 22 - 2 * beat
    pose.line(x, y, tipX, tipY, 1, c.white)
    pose.polygon([[tipX, tipY], [tipX + side * 14, tipY + 2 + 3 * beat], [tipX, tipY + 9]], c.red)
    pose.rect(tipX + side * 3, tipY + 3, 3, 2, c.white)
  } else if (seat === 1) {
    const [x, y] = anchor(28, 25)
    const rimX = x + 16, rimY = y - 3 - 4 * beat
    pose.polygon([[x, y - 1], [rimX, rimY - 4], [rimX, rimY + 5], [x, y + 2]], c.red)
    pose.rect(rimX - 1, rimY - 4, 2, 9, c.white)
    pose.line(x + 6, y + 2, x + 5, y + 5, 2, c.redDeep)
  } else if (seat === 3) {
    // Two inflatable clappers meet above the hands, then open again.
    const [x, y] = anchor(12, 37)
    const gap = Math.round((1 + swing) * 4)
    pose.line(x - 3, y, x + 2 - gap, y - 14, 3, c.red)
    pose.line(x + 7, y + 1, x + 3 + gap, y - 13, 3, c.white)
    const hand = photoColor(25, 28)
    pose.rect(x - 4, y - 1, 5, 4, hand)
    pose.rect(x + 6, y, 5, 4, hand)
  } else {
    // The jersey wearer lifts a scarf from chest height. The last fan holds it overhead.
    const overhead = seat === 5
    const [x, y] = anchor(overhead ? 23 : 26, overhead ? 5 : 29 - 5 * beat)
    const span = overhead ? 13 : 18
    const tilt = Math.round(2 * swing)
    if (!overhead) {
      const skin = photoColor(24, 34)
      pose.line(...anchor(13, 34), x - span + 1, y + 2 - tilt, 3, skin)
      pose.line(...anchor(37, 33), x + span - 2, y + 2 + tilt, 3, skin)
    }
    pose.polygon([[x - span, y - tilt], [x + span, y + tilt],
      [x + span, y + 5 + tilt], [x, y + 7], [x - span, y + 5 - tilt]], c.red)
    pose.rect(x - span, y - tilt, 2, 8, c.white)
    pose.rect(x + span - 1, y + tilt, 2, 8, c.white)
    pose.rect(x - 6, y + 2, 12, 1, c.white)
  }
  return pose
}

// Cache these small indexed poses once. Rendering a crowd frame then only copies sprite pixels.
const cheerPoses = cheerRates.map((_, seat) => Array.from({ length: poseCount },
  (_, index) => makeCheerPose(seat, index * Math.PI * 2 / poseCount)))

function drawAudience(river, frame, frameCount, durationMs) {
  const crowdWidth = Math.min(audience.width, river.width)
  const left = Math.max(0, Math.floor((river.width - crowdWidth) / 2) - 30)
  for (let seat = 0; seat < cheerRates.length; seat++) {
    // Complete whole cheers on a loop and slow them down if the upload budget thins the frames.
    const cycles = Math.min(Math.max(1, Math.round(durationMs * cheerRates[seat] / 1000)), Math.max(1, Math.floor(frameCount / 6)))
    const phase = frame / frameCount * cycles + seat * 0.37
    const pose = cheerPoses[seat][Math.floor(phase * poseCount) % poseCount]
    const start = Math.floor(seat * crowdWidth / cheerRates.length)
    const end = Math.floor((seat + 1) * crowdWidth / cheerRates.length)
    for (let x = start; x < end; x++) {
      const sourceX = Math.floor((x - start) * seatWidth / (end - start))
      for (let y = 0; y < 44; y++) {
        const pixel = pose.pixels[y * seatWidth + sourceX]
        if (pixel) river.pixels[(55 + y) * river.width + left + x] = pixel
      }
    }
  }
}

function drawNightBank(river) {
  const c = color, w = river.width, center = Math.floor(w / 2)
  river.rect(0, 0, w, BANK, c.sky)
  river.rect(0, 21, w, 24, c.dusk)
  river.rect(0, 38, w, 29, c.horizon)
  for (let x = 7; x < w; x += 23) {
    river.rect(x, 3 + (x * 17) % 20, x % 3 ? 1 : 2, 1, c.lamp)
  }

  const moonX = Math.floor(w * 0.76)
  river.ellipse(moonX, 28, 17, 17, c.moon)
  river.rect(moonX - 13, 20, 20, 1, c.moonLight)
  river.rect(moonX + 4, 37, 18, 2, c.dusk)
  for (let x = 0; x < w; x += 11) {
    const top = 39 + (x * 7 % 14)
    river.rect(x, top, 8 + (x % 5), 62 - top, c.far)
    if (x % 4) river.rect(x + 2, top + 3, 2, 1, c.lamp)
  }
  // Twin floodlight gantries behind the quay.
  for (const x of [Math.round(w * 0.15), Math.round(w * 0.93)]) {
    river.polygon([[x - 6, 22], [x + 8, 22], [x + 37, 56], [x + 7, 54]], c.far)
    river.rect(x, 19, 3, 48, c.iron)
    river.rect(x - 8, 18, 21, 6, c.iron)
    for (let i = 0; i < 4; i++) river.rect(x - 6 + i * 5, 19, 3, 2, c.flare)
  }
  river.rect(0, 58, w, 12, c.iron)
  for (let x = 0; x < w; x += 12) {
    const h = 3 + (x * 7 % 9)
    river.rect(x, 58 - h, 10, h, c.iron)
    if (x % 5) river.rect(x + 3, 58 - h + 3, 3, 1, c.redDeep)
  }

  const left = center - 88
  river.polygon([[left - 8, 11], [left + 167, 11], [left + 156, 59], [left - 16, 59]], c.ink)
  river.rect(left - 6, 11, 175, 1, c.steel)
  river.polygon([[left + 119, 56], [left + 157, 56], [left + 155, 59], [left + 116, 59]], c.red)
  for (let row = 0; row < crest.length; row++) {
    for (let col = 0; col < crest[row].length; col++) {
      const fill = crestColors[crest[row][col]]
      if (fill !== undefined) river.rect(left + col, 17 + row, 1, 1, fill)
    }
  }
  river.name('NIGHTRAID', left + 40, 22, 9)
  river.name('BATTLEGROUND', left + 41, 41, 12, 1, c.lamp)
  river.rect(0, 63, w, 41, c.iron)
  for (let y = 67; y <= 97; y += 11) {
    river.rect(0, y, w, 2, c.steel)
    river.rect(0, y + 2, w, 3, c.ink)
  }
  river.rect(0, 99, w, 2, c.steel)
  river.rect(0, 104, w, 2, c.red)
  river.rect(0, 106, w, BANK - 106, c.ink)
  for (let x = 5; x < w; x += 24) river.rect(x, 110, 10, 1, c.redDeep)
}

function makeRiver(lanes, laneHeight) {
  const count = lanes.length
  const river = new Bitmap(WIDTH, BANK + count * laneHeight + 6)
  const c = color
  drawNightBank(river)
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
    river.rect(4, mid - 10, 120, 21, c.tag)
    const bib = lanes[lane].bib ?? lane + 1
    const width = Math.max(19, String(bib).length * 8 + 5)
    river.rect(4, mid - 10, width, 21, c.navy)
    river.rect(4, mid - 10, 3, 21, bibs[(bib - 1) % bibs.length])
    river.number(bib, 6 + width / 2, mid, 2)
    const nameX = width + 8
    river.name(lanes[lane].name, nameX, Math.round(mid - 7), Math.floor((124 - nameX) / 12))
  }
  const bottom = BANK + count * laneHeight
  river.rect(0, bottom, WIDTH, 6, c.tag)
  for (let y = BANK; y < bottom; y += 5) {
    const alternate = Math.floor((y - BANK) / 5) % 2
    river.rect(STRIPE, y, 5, Math.min(5, bottom - y), alternate ? c.navy : c.white)
    river.rect(STRIPE + 5, y, 5, Math.min(5, bottom - y), alternate ? c.white : c.navy)
  }
  if (count) drawFinishFlag(river, STRIPE)
  return river
}

function drawFinishFlag(river, stripe, top = 74) {
  const c = color
  river.rect(stripe - 1, top, 3, BANK - top, c.steel)
  river.rect(stripe - 1, top - 3, 3, 3, c.red)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      river.rect(stripe + 2 + col * 4, top + row * 4 + Math.round(2 * Math.sin(col)), 4, 4, (row + col) % 2 ? c.white : c.navy)
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
  drawNightBank(river)
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
    if (index % rows === 0 && w >= 100) drawFinishFlag(river, stripe, BANK - 15)
    if (tag > 1) {
      river.rect(x + 1, y + 1, tag - 1, h - 2, color.tag)
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
    river.rect(left, top + Math.floor(height / 2), width - 1, Math.ceil(height / 2), out ? color.tag : color.yellow)
    river.rect(left + width - 3, top, 2, Math.ceil(height / 2), out ? color.tag : color.light)
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

export async function renderDuckRaceGif({ lanes, frames, finish = 12, replay = false, loop = false, durationMs = 2500, sampled = false }) {
  if (!lanes.length || !frames.length || !(finish > 0)
    || frames.some(frame => frame.positions.length !== lanes.length)) throw new RangeError('Invalid duck race frames')
  let density = 1
  let scene = raceScene(lanes)
  let legs = Math.max(1, frames.length - 1)
  const runtime = replay ? Math.min(15_000, sampled ? durationMs : legs * 1500) : durationMs
  const targetFrames = Math.max(2, Math.min(100, Math.round(runtime / 110), Math.floor(26_000_000 / scene.river.pixels.length)))
  let steps = sampled ? 1 : Math.max(1, Math.floor(targetFrames / legs))
  for (;;) {
    const { river, tracks } = scene
    const background = river.pixels.slice()
    const gif = gifenc.GIFEncoder()
    encode: for (let leg = 0; leg < legs; leg++) {
      const from = frames[leg], to = frames[Math.min(leg + 1, frames.length - 1)]
      for (let step = leg ? 1 : 0; step <= steps; step++) {
        const t = step / steps
        river.pixels.set(background)
        const frame = leg * steps + step
        drawAudience(river, frame, steps * legs + 1, runtime)
        const current = t === 0 ? from : to
        if (current.round) {
          const label = 'ROUND ' + current.round
          river.rect(5, 29, label.length * 12 + 8, current.lastOut == null ? 20 : 32, color.ink)
          river.rect(5, 29, 2, 19, color.red)
          river.name(label, 10, 32, label.length)
          if (current.lastOut != null) river.name('OUT ' + (current.lastOut + 1), 11, 51, 12, 1, color.lamp)
        }
        for (let lane = 0; lane < lanes.length; lane++) {
          const previous = from.positions[lane], next = to.positions[lane]
          if (next == null && (previous == null || t === 1)) continue
          const track = tracks[lane]
          const at = value => track.start + (track.stripe - track.start) * Math.min(1, Math.max(0, value / finish))
          const fromCrossed = sampled ? from.crossed : from.winner
          const toCrossed = sampled ? to.crossed : to.winner
          const fromX = fromCrossed === lane ? track.stripe + 3 : at(previous ?? next)
          // Meet the stripe at the timed finish; the replay also shows the winner clearing it.
          const toX = toCrossed === lane ? (sampled ? track.stripe + 3 : replay ? track.end : track.stripe + 1) : at(next ?? previous)
          const out = from.out?.[lane] || (t === 1 && to.out?.[lane])
          const strokeTime = sampled ? (leg + t) / legs * runtime / 1000 * 1.5 : (leg + t) * 2
          drawSwimmer(river, track, fromX + (toX - fromX) * t, strokeTime + lane / 4, out)
        }
        const first = leg === 0 && step === 0
        const last = leg === legs - 1 && step === steps
        const tick = runtime / ((steps * legs + 1) * 10)
        const delay = (Math.round((frame + 1) * tick) - Math.round(frame * tick)) * 10
        gif.writeFrame(river.pixels, river.width, river.height, {
          palette: first ? palette : undefined, repeat: replay || loop ? 0 : -1,
          delay: last && replay && !loop ? 600 : Math.max(20, delay), colorDepth: 8,
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
