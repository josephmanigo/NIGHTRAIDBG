// A plan records one uninterrupted stretch of the race. Host kicks start a new stretch;
// keeping the old one lets the replay use the field that actually raced.
function makePlan(race, order, from, completed = 0, fraction = 0) {
  const rounds = race.mode === 'last_standing' ? Math.max(1, order.length - 1) : 1
  const lapMs = (race.endsAt - from) / (rounds - fraction)
  return {
    order, ranks: new Map(order.map((duck, index) => [duck, index])),
    from, origin: from - fraction * lapMs, lapMs, rounds, completed,
  }
}

export function startCourse(race, now, random) {
  race.startedAt = now
  race.endsAt = now + race.durationMs
  race.phase = 'racing'
  race.stop = new AbortController()
  race.lanes = race.ducks.slice()
  for (const [i, duck] of race.lanes.entries()) {
    duck.bib = i + 1
    duck.speed = random(1000, 2001)
  }
  // Drawing without replacement gives every survivor 1 / survivors chance of the
  // fastest pace in its next knockout round. A finish-line tie uses the same fair draw.
  const order = race.lanes.slice()
  for (let i = 0; i < order.length - 1; i++) {
    const j = i + random(0, order.length - i)
    const temp = order[i]
    order[i] = order[j]
    order[j] = temp
  }
  if (race.mode !== 'last_standing') order.sort((a, b) => b.speed - a.speed)
  race.heatSeeds = Array.from({ length: race.mode === 'last_standing' ? order.length - 1 : 1 },
    () => random(0, 0x100000000))
  race.plans = [makePlan(race, order, now)]
}

export function startPlaybackClock(race, publishedAt) {
  const shift = publishedAt - race.startedAt
  race.startedAt += shift
  race.endsAt += shift
  for (const plan of race.plans) {
    plan.from += shift
    plan.origin += shift
  }
}

function lapAt(plan, time) {
  const elapsed = (time - plan.origin) / plan.lapMs
  const index = Math.min(plan.rounds - 1, Math.max(0, Math.floor(elapsed)))
  return { index, fraction: Math.min(1, Math.max(0, elapsed - index)) }
}

export function currentDucks(race, now) {
  if (!race.plans) return race.ducks
  const plan = race.plans.at(-1)
  if (race.mode !== 'last_standing') return plan.order
  return plan.order.slice(lapAt(plan, now).index)
}

export function removeFromCourse(race, duck, now) {
  const previous = race.plans.at(-1)
  const { index, fraction } = lapAt(previous, now)
  const order = previous.order.slice(index).filter(racer => racer !== duck)
  if (order.length === 0) {
    race.phase = 'cancelled'
    race.closedReason = 'The race closed because no ducks remain.'
  } else {
    // Preserve the current lap's progress and the original deadline.
    race.plans.push(makePlan(race, order, now, previous.completed + index, Math.min(0.999999, fraction)))
    if (race.mode === 'last_standing' && order.length === 1) race.endsAt = now
  }
  race.stop.abort()
  race.stop = new AbortController()
}

export function courseResult(race) {
  const plan = race.plans.at(-1)
  if (race.mode === 'last_standing') {
    return { winner: plan.order.at(-1), lastOut: plan.order.at(-2), rounds: plan.completed + plan.order.length - 1 }
  }
  return { winner: plan.order[0], tied: plan.order.length > 1 && plan.order[0].speed === plan.order[1].speed }
}

// Generate repeatable stroke profiles from the round's random seed so live
// playback, a host kick and the replay all sample the same physical movement.
function mix32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return (value ^ (value >>> 15)) >>> 0
}

function strokeProfile(seed, bib) {
  const bits = mix32(seed ^ Math.imul(bib, 0x9e3779b1))
  return {
    pace: 0.67 + 0.315 * (bits & 255) / 255,
    early: 0.4 + ((bits >>> 8) & 255) / 128,
    middle: 0.4 + ((bits >>> 16) & 255) / 128,
    late: 0.4 + (bits >>> 24) / 128,
  }
}

function lapDistance(fraction, profile) {
  const stage = fraction * 3
  const distance = Math.min(1, stage) * profile.early
    + Math.min(1, Math.max(0, stage - 1)) * profile.middle
    + Math.max(0, stage - 2) * profile.late
  return distance / (profile.early + profile.middle + profile.late)
}

export function courseFrames(race, from, to, replay = false) {
  // Capture all lanes at each instant. Bound the temporal sample count for large fields.
  const duration = Math.max(1, to - from)
  const intervals = Math.max(2, Math.min(180, Math.ceil((replay ? Math.min(15000, duration) : duration) / 95),
    Math.floor(500_000 / race.lanes.length)))
  const frames = []
  const knockout = race.mode === 'last_standing'
  let planIndex = 0
  let previousLap = -1
  let profileRound = -1
  let profiles
  for (let step = 0; step <= intervals; step++) {
    const time = from + duration * step / intervals
    while (planIndex + 1 < race.plans.length && race.plans[planIndex + 1].from <= time) {
      planIndex++
      previousLap = -1
    }
    const plan = race.plans[planIndex]
    let { index, fraction } = lapAt(plan, time)
    if (time >= race.endsAt) {
      index = plan.rounds - 1
      fraction = 1
    }
    // Show the crossing before cutting to the next starting line. Never interpolate
    // a removed duck backwards from the finish or into the following round.
    if (previousLap >= 0 && index > previousLap && step !== intervals) {
      previousLap = index
      index--
      fraction = 1
    } else previousLap = index
    const leader = plan.order[index]
    const leaderBib = leader.bib - 1
    const round = plan.completed + index + 1
    if (round !== profileRound) {
      const seed = mix32(race.heatSeeds[round - 1] ^ round)
      profiles = race.lanes.map(duck => strokeProfile(seed, duck.bib))
      profileRound = round
    }
    const positions = race.lanes.map((duck, lane) => {
      const rank = plan.ranks.get(duck)
      if (rank == null || rank < index) return null
      // Each swimmer's speed stays positive throughout the lap. Its average pace
      // determines its crossing time, with a small stroke variation between ducks.
      const ratio = rank === index ? 1 : knockout ? profiles[lane].pace : Math.min(0.985, duck.speed / leader.speed)
      return 12 * ratio * lapDistance(fraction, profiles[lane])
    })
    const crossed = fraction >= 1 ? leaderBib : null
    const finished = time >= race.endsAt
    const winner = finished ? (knockout ? plan.order.at(-1) : leader).bib - 1 : null
    const lastOut = knockout ? (crossed ?? (index > 0 ? plan.order[index - 1].bib - 1 : null)) : null
    frames.push({ positions, round: knockout ? round : 0, crossed, lastOut, winner })
  }
  return frames
}
