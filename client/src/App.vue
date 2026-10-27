<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

interface Participant {
  name: string
  ready: boolean
  connected: boolean
}

interface ServerState {
  type: 'state'
  clientId: number
  ownName: string
  participants: Participant[]
  reconnectToken: string
  partner: string | null
  phase: 'waiting' | 'assigned'
}

interface ServerError {
  type: 'error'
  message: string
}

const name = ref('')
const email = ref('')
const connected = ref(false)
const connectionState = ref<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
const errorMessage = ref('')
const state = ref<ServerState | null>(null)
const pointerPressed = ref(false)
const keyboardReady = ref(false)
const ready = computed(() => pointerPressed.value || keyboardReady.value)
const otherParticipants = computed(() =>
  (state.value?.participants ?? []).filter((participant) => participant.name !== state.value?.ownName),
)
const connectionLabel = computed(() => {
  if (connectionState.value === 'connecting') return 'Verbindung wird hergestellt …'
  if (connectionState.value === 'connected') return 'Verbunden'
  if (connectionState.value === 'closed') return 'Verbindung beendet'
  return ''
})

let socket: WebSocket | null = null
let heartbeat: number | undefined
let reconnectTimer: number | undefined
let reconnectAttempts = 0
let reconnectAllowed = true
let reconnectToken = ''

function sendHeartbeat() {
  if (socket?.readyState !== WebSocket.OPEN || state.value?.phase === 'assigned') return

  socket.send(
    JSON.stringify({
      type: 'heartbeat',
      name: name.value.trim(),
      email: email.value.trim(),
      token: reconnectToken,
      ready: ready.value,
    }),
  )
}

function connect(isReconnect = false) {
  const normalizedName = name.value.trim()
  if (!isReconnect && !normalizedName) {
    errorMessage.value = 'Bitte gib deinen Namen ein.'
    return
  }

  if (!isReconnect) {
    reconnectAllowed = true
    reconnectAttempts = 0
    reconnectToken = ''
    errorMessage.value = ''
    name.value = normalizedName
  }
  connectionState.value = 'connecting'
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const currentSocket = new WebSocket(`${protocol}//${window.location.host}/ws`)
  socket = currentSocket

  currentSocket.addEventListener('open', () => {
    if (socket !== currentSocket) return
    connected.value = true
    connectionState.value = 'connected'
    reconnectAttempts = 0
    sendHeartbeat()
    heartbeat = window.setInterval(sendHeartbeat, 1000)
  })

  currentSocket.addEventListener('message', (event: MessageEvent<string>) => {
    if (socket !== currentSocket) return
    const message = JSON.parse(event.data) as ServerState | ServerError
    if (message.type === 'error') {
      errorMessage.value = message.message
      reconnectAllowed = false
      currentSocket.close()
      return
    }
    state.value = message
    reconnectToken = message.reconnectToken
  })

  currentSocket.addEventListener('error', () => {
    if (socket !== currentSocket) return
    errorMessage.value = 'Die Verbindung zum Server konnte nicht hergestellt werden.'
  })

  currentSocket.addEventListener('close', () => {
    if (socket !== currentSocket) return
    connected.value = false
    connectionState.value = 'closed'
    if (heartbeat !== undefined) window.clearInterval(heartbeat)
    heartbeat = undefined
    pointerPressed.value = false
    keyboardReady.value = false
    if (state.value?.partner || !reconnectAllowed) return
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 5000)
    reconnectAttempts += 1
    connectionState.value = 'connecting'
    errorMessage.value = ''
    reconnectTimer = window.setTimeout(() => connect(true), delay)
  })
}

function setPointerReady(event: PointerEvent, value: boolean) {
  if (!connected.value || state.value?.phase === 'assigned') return
  event.preventDefault()
  pointerPressed.value = value
  if (value && event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'g' && connected.value) {
    event.preventDefault()
    keyboardReady.value = !keyboardReady.value
  }
}

function onWindowBlur() {
  pointerPressed.value = false
}

window.addEventListener('keydown', onKeyDown)
window.addEventListener('blur', onWindowBlur)

onBeforeUnmount(() => {
  if (heartbeat !== undefined) window.clearInterval(heartbeat)
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('blur', onWindowBlur)
  socket?.close()
})
</script>

<template>
  <main class="page">
    <section class="card" aria-live="polite">
      <div class="ornament" aria-hidden="true">✳</div>
      <p class="eyebrow">Das große Los</p>
      <h1>Megalodi-Wichteln</h1>

      <form v-if="!connected && !state" class="entry-form" @submit.prevent="connect">
        <label for="name">Dein Name</label>
        <input
          id="name"
          v-model="name"
          autocomplete="name"
          maxlength="60"
          placeholder="Name oder Spitzname"
          required
        />
        <label for="email">E-Mail <span>(optional)</span></label>
        <input
          id="email"
          v-model="email"
          autocomplete="email"
          maxlength="254"
          placeholder="name@beispiel.de"
          type="email"
        />
        <button class="primary-button join-button" type="submit" :disabled="connectionState === 'connecting'">
          {{ connectionState === 'connecting' ? 'Verbinde …' : 'Teilnehmen' }}
        </button>
      </form>

      <template v-else-if="state?.partner">
        <p class="result-own-label">Dein Name</p>
        <p class="result-own-name">{{ state.ownName }}</p>
        <p class="result-intro">Du überraschst dieses Jahr</p>
        <p class="partner-name">{{ state.partner }}</p>
        <p class="quiet">Viel Freude beim Wichteln!</p>
      </template>

      <template v-else-if="state">
        <p class="welcome">Hallo, <strong>{{ state.ownName }}</strong></p>
        <button
          class="primary-button ready-button"
          :class="{ active: ready }"
          type="button"
          :aria-pressed="ready"
          @pointerdown="setPointerReady($event, true)"
          @pointerup="setPointerReady($event, false)"
          @pointercancel="setPointerReady($event, false)"
          @lostpointercapture="pointerPressed = false"
        >
          <span class="button-indicator" aria-hidden="true"></span>
          {{ ready ? 'Bereit – gedrückt halten' : 'Gedrückt halten, wenn alle da sind' }}
        </button>
        <p class="hint">Lass los, um deine Bereitschaft zurückzunehmen.</p>

        <div class="participant-section">
          <div class="list-heading">
            <h2>Teilnehmende</h2>
            <span class="count">{{ state.participants.length }} / 20</span>
          </div>
          <p v-if="state.participants.length < 3" class="hint">
            Mindestens 3 Personen werden zum Wichteln benötigt.
          </p>
          <ul class="participant-list">
            <li v-for="participant in state.participants" :key="participant.name">
              <span>{{ participant.name }}<span v-if="participant.name === state.ownName"> (du)</span></span>
              <span class="status" :class="{ ready: participant.ready, disconnected: !participant.connected }">
                <span class="status-dot" aria-hidden="true"></span>
                {{ !participant.connected ? 'Verbindung …' : participant.ready ? 'Bereit' : 'Wartet' }}
              </span>
            </li>
          </ul>
        </div>
      </template>

      <p v-if="connectionLabel && !state?.partner" class="connection-status">
        <span class="connection-dot" :class="{ connected }" aria-hidden="true"></span>{{ connectionLabel }}
      </p>
      <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
      <p v-if="state?.phase === 'assigned' && !state.partner" class="quiet">
        Die Auslosung läuft …
      </p>
    </section>
    <footer>Ein kleines Geheimnis für eine große Weihnachtsfreude.</footer>
  </main>
</template>
