import { randomInt } from 'node:crypto'

export function drawPartners<T>(participants: readonly T[]): Map<T, T> {
  if (participants.length < 3 || participants.length > 20) {
    throw new Error('The draw requires between 3 and 20 participants.')
  }

  let shuffled: T[]
  do {
    shuffled = [...participants]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1)
      ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
    }
  } while (shuffled.some((participant, index) => participant === participants[index]))

  return new Map(participants.map((participant, index) => [participant, shuffled[index]]))
}
