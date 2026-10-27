import 'dotenv/config'
import express from 'express'
import { appendFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import nodemailer from 'nodemailer'
import { drawPartners } from './draw'

const port = Number(process.env.PORT ?? 3000)
const logDirectory = process.env.LOG_DIR ?? path.resolve(process.cwd(), 'data')
const clientDirectory = path.resolve(__dirname, '../../client/dist')
const maxParticipants = 20
const minParticipants = 3
const readyDurationMs = 2000
const resultDurationMs = 5000
const heartbeatTimeoutMs = 15000
const reconnectGraceMs = 30000

interface ClientHeartbeat {
  type: 'heartbeat'
  name: string
  email: string
  token: string
  ready: boolean
}

interface Participant {
  id: number
  name: string
  normalizedName: string
  email: string
  token: string
  ready: boolean
  lastSeenAt: number
  socket: WebSocket
  disconnectedAt: number | null
  partner: string | null
  resultMessagesSent: number
}

interface ClientStateMessage {
  type: 'state'
  clientId: number
  ownName: string
  participants: Array<{ name: string; ready: boolean; connected: boolean }>
  reconnectToken: string
  partner: string | null
  phase: 'waiting' | 'assigned'
}

const app = express()
app.disable('x-powered-by')
app.use(express.static(clientDirectory))
app.get('*', (_request, response) => response.sendFile(path.join(clientDirectory, 'index.html')))

const httpServer = createServer(app)
const webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' })
const participants = new Map<number, Participant>()
let nextClientId = 1
let readySince: number | null = null
let assignedAt: number | null = null
let assigning = false

const smtpHost = process.env.SMTP_HOST
const smtpPort = Number(process.env.SMTP_PORT ?? 587)
const smtpUser = process.env.SMTP_USER
const smtpPassword = process.env.SMTP_PASSWORD
const mailFrom = process.env.MAIL_FROM
const smtpConfigured = Boolean(smtpHost || smtpUser || smtpPassword || mailFrom)

if (smtpConfigured && (!smtpHost || !mailFrom)) {
  throw new Error('SMTP_HOST and MAIL_FROM must be configured together to enable email.')
}

const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      ...(smtpUser && smtpPassword ? { auth: { user: smtpUser, pass: smtpPassword } } : {}),
    })
  : null

console.info(
  smtpConfigured
    ? `SMTP email delivery enabled (SMTP_HOST: ${Boolean(smtpHost)}, MAIL_FROM: ${Boolean(mailFrom)}).`
    : 'SMTP email delivery disabled (SMTP_HOST: false, MAIL_FROM: false).',
)

function sendError(socket: WebSocket, message: string) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'error', message }))
  }
  socket.close(1008, message.slice(0, 120))
}

function allParticipantsReady(): boolean {
  return (
    participants.size >= minParticipants &&
    participants.size <= maxParticipants &&
    [...participants.values()].every(
      (participant) =>
        participant.ready &&
        participant.disconnectedAt === null &&
        participant.socket.readyState === WebSocket.OPEN,
    )
  )
}

function updateReadyClock(now: number) {
  if (!allParticipantsReady() || assignedAt !== null) {
    readySince = null
    return
  }
  if (readySince === null) readySince = now
}

function createStateMessage(participant: Participant): ClientStateMessage {
  return {
    type: 'state',
    clientId: participant.id,
    ownName: participant.name,
    participants: [...participants.values()].map(({ name, ready, disconnectedAt, socket }) => ({
      name,
      ready,
      connected: disconnectedAt === null && socket.readyState === WebSocket.OPEN,
    })),
    reconnectToken: participant.token,
    partner: participant.partner,
    phase: assignedAt === null ? 'waiting' : 'assigned',
  }
}

async function sendAssignmentEmails(
  assignments: Map<Participant, Participant>,
  timestamp: Date,
) {
  const recipients = [...assignments.entries()].filter(([participant]) => participant.email)
  if (!recipients.length) return
  if (!mailer || !mailFrom) {
    console.error('Email delivery skipped: SMTP_HOST and MAIL_FROM are not configured.')
    return
  }

  const subject = `Megalodi-Wichteln am ${timestamp.toLocaleString('de-DE')}`
  const outcomes = await Promise.allSettled(
    recipients.map(([participant, partner]) =>
      mailer.sendMail({
        from: mailFrom,
        to: participant.email,
        subject,
        text: `Hallo ${participant.name},\n\nDu überraschst ${partner.name}`,
      }),
    ),
  )
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      console.error(`Could not send Wichteln email to ${recipients[index][0].email}:`, outcome.reason)
    }
  })
}

async function createAssignment() {
  if (assigning || assignedAt !== null || !allParticipantsReady()) return
  assigning = true
  const roster = [...participants.values()]
  const assignments = drawPartners(roster)
  const timestamp = new Date()
  const logLines = [
    `Megalodi-Wichteln am ${timestamp.toISOString()}`,
    ...[...assignments.entries()].map(([participant, partner]) => `${participant.name} -> ${partner.name}`),
    '',
  ]

  try {
    await mkdir(logDirectory, { recursive: true })
    await appendFile(path.join(logDirectory, 'assignments.log'), `${logLines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    console.error('Could not write the internal assignment log; assignment was not published:', error)
    assigning = false
    return
  }

  for (const [participant, partner] of assignments) {
    participant.partner = partner.name
  }
  assignedAt = Date.now()
  console.info(`Wichteln assignment created for ${roster.length} participants.`)
  void sendAssignmentEmails(assignments, timestamp)
}

function processHeartbeat(socket: WebSocket, rawData: Buffer) {
  if (socket.readyState !== WebSocket.OPEN) return

  let message: unknown
  try {
    message = JSON.parse(rawData.toString())
  } catch {
    sendError(socket, 'Ungültige Nachricht.')
    return
  }

  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'heartbeat' ||
    !('name' in message) ||
    typeof message.name !== 'string' ||
    !('email' in message) ||
    typeof message.email !== 'string' ||
    !('token' in message) ||
    typeof message.token !== 'string' ||
    !('ready' in message) ||
    typeof message.ready !== 'boolean'
  ) {
    sendError(socket, 'Ungültige Anmeldedaten.')
    return
  }

  const heartbeat = message as ClientHeartbeat
  const name = heartbeat.name.trim()
  const email = heartbeat.email.trim()
  if (!name || name.length > 60 || email.length > 254) {
    sendError(socket, 'Bitte einen Namen (maximal 60 Zeichen) und eine gültige E-Mail-Adresse eingeben.')
    return
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendError(socket, 'Die E-Mail-Adresse ist ungültig.')
    return
  }

  let participant = [...participants.values()].find((entry) => entry.socket === socket)
  let sendInitialState = false
  if (assigning) {
    if (!participant) sendError(socket, 'Die Auslosung läuft bereits.')
    return
  }
  if (!participant) {
    if (assignedAt !== null) {
      sendError(socket, 'Die Auslosung wurde bereits durchgeführt.')
      return
    }
    if (heartbeat.token) {
      participant = [...participants.values()].find((entry) => entry.token === heartbeat.token)
      if (participant) {
        if (participant.name !== name || participant.email !== email) {
          sendError(socket, 'Die Wiederverbindung konnte nicht zugeordnet werden.')
          return
        }
        if (participant.socket.readyState === WebSocket.OPEN) participant.socket.terminate()
        participant.socket = socket
        participant.disconnectedAt = null
        participant.ready = false
        sendInitialState = true
      }
    }
    if (!participant) {
      const normalizedName = name.toLocaleLowerCase('de-DE')
      if ([...participants.values()].some((entry) => entry.normalizedName === normalizedName)) {
        sendError(socket, 'Dieser Name ist bereits angemeldet. Bitte verwende einen eindeutigen Namen.')
        return
      }
      if (participants.size >= maxParticipants) {
        sendError(socket, 'Es können höchstens 20 Personen teilnehmen.')
        return
      }
      participant = {
        id: nextClientId++,
        name,
        normalizedName,
        email,
        token: randomBytes(32).toString('base64url'),
        ready: false,
        lastSeenAt: Date.now(),
        socket,
        disconnectedAt: null,
        partner: null,
        resultMessagesSent: 0,
      }
      participants.set(participant.id, participant)
      sendInitialState = true
    }
  } else if (name !== participant.name || email !== participant.email) {
    sendError(socket, 'Name und E-Mail können nach der Anmeldung nicht geändert werden.')
    return
  }

  if (!participant) {
    sendError(socket, 'Die Anmeldung konnte nicht abgeschlossen werden.')
    return
  }
  if (assignedAt !== null) return
  participant.ready = heartbeat.ready
  participant.lastSeenAt = Date.now()
  updateReadyClock(participant.lastSeenAt)
  if (sendInitialState && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(createStateMessage(participant)))
  }
}

webSocketServer.on('connection', (socket) => {
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      sendError(socket, 'Binäre Nachrichten werden nicht unterstützt.')
      return
    }
    processHeartbeat(socket, data as Buffer)
  })

  socket.on('close', () => {
    if (assignedAt !== null || assigning) return
    const participant = [...participants.values()].find((entry) => entry.socket === socket)
    if (participant) {
      participant.disconnectedAt = Date.now()
      participant.ready = false
    }
    updateReadyClock(Date.now())
  })
})

const broadcastTimer = setInterval(() => {
  const now = Date.now()
  if (assignedAt === null) {
    for (const participant of participants.values()) {
      if (
        participant.disconnectedAt === null &&
        now - participant.lastSeenAt > heartbeatTimeoutMs
      ) {
        participant.disconnectedAt = now
        participant.ready = false
        participant.socket.terminate()
      }
      if (
        participant.disconnectedAt !== null &&
        now - participant.disconnectedAt > reconnectGraceMs
      ) {
        participants.delete(participant.id)
      }
    }
    updateReadyClock(now)
    if (readySince !== null && now - readySince >= readyDurationMs) {
      void createAssignment()
    }
  }

  for (const participant of [...participants.values()]) {
    if (participant.socket.readyState !== WebSocket.OPEN) continue
    participant.socket.send(JSON.stringify(createStateMessage(participant)))
    if (assignedAt !== null) participant.resultMessagesSent += 1
  }

  if (
    assignedAt !== null &&
    (now - assignedAt >= resultDurationMs ||
      [...participants.values()].every((participant) => participant.resultMessagesSent >= 5))
  ) {
    for (const participant of participants.values()) participant.socket.close(1000, 'Auslosung beendet')
    participants.clear()
    readySince = null
    assignedAt = null
    assigning = false
    console.info('Wichteln session completed; server is ready for the next draw.')
  }
}, 1000)

httpServer.listen(port, '0.0.0.0', () => {
  console.info(`Megalodi-Wichteln server listening on port ${port}.`)
})
