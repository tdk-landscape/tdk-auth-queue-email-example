<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  MAILPIT_URL,
  type Profile,
  type Report,
  STATUS_LABEL,
  createReportsApi,
  recentPeriods,
  signIn,
} from './api';

const token = ref('');
const profile = ref<Profile | null>(null);
const reports = ref<Report[]>([]);
const error = ref('');
const busy = ref(false);
const periods = recentPeriods();
const period = ref(periods[0]);
const crashFirstAttempt = ref(false);

const api = computed(() => (token.value ? createReportsApi(token.value) : null));
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  if (!api.value) return;
  try {
    reports.value = await api.value.list();
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function login(username: string, password: string) {
  busy.value = true;
  try {
    token.value = await signIn(username, password);
    profile.value = await api.value!.me();
    await refresh();
    timer = setInterval(refresh, 1000);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function logout() {
  clearInterval(timer);
  token.value = '';
  profile.value = null;
  reports.value = [];
}

async function requestReport() {
  busy.value = true;
  try {
    await api.value!.request(period.value, crashFirstAttempt.value);
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <main class="page">
    <header class="top">
      <div>
        <p class="eyebrow">Vue 3 + Hono + NATS on TDK</p>
        <h1>Usage reports</h1>
      </div>
      <a class="inbox" :href="MAILPIT_URL" target="_blank" rel="noopener">Open the email inbox</a>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section v-if="!profile" class="card">
      <h2>Sign in</h2>
      <p class="muted">
        The identity provider here is the <code>auth-emulator</code> resource. Tokens are checked by
        <code>reports-api</code> exactly as it would check Auth0 or Cognito tokens.
      </p>
      <div class="row">
        <button :disabled="busy" @click="login('alice', 'alice-pass')">Sign in as Alice</button>
        <button :disabled="busy" class="ghost" @click="login('bob', 'bob-pass')">Sign in as Bob</button>
      </div>
    </section>

    <template v-else>
      <section class="card">
        <div class="row between">
          <div>
            <h2>Email me a usage report</h2>
            <p class="muted">
              Signed in as <strong>{{ profile.name }}</strong> ({{ profile.email }}). The report is queued, built by
              <code>report-worker</code> and emailed to that address.
            </p>
          </div>
          <button class="ghost" @click="logout">Sign out</button>
        </div>
        <form class="row" @submit.prevent="requestReport">
          <label>
            Month
            <select v-model="period">
              <option v-for="p in periods" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="check">
            <input v-model="crashFirstAttempt" type="checkbox" />
            Crash the worker on the first attempt
          </label>
          <button type="submit" :disabled="busy">Request report</button>
        </form>
      </section>

      <section class="card">
        <h2>Your reports</h2>
        <p v-if="reports.length === 0" class="muted">Nothing yet. Request one above.</p>
        <ul v-else class="list">
          <li v-for="r in reports" :key="r.id">
            <div>
              <strong>{{ r.period }}</strong>
              <span class="muted"> · {{ r.id }} · attempt {{ r.attempts || '-' }}</span>
              <div v-if="r.sentTo" class="muted">{{ r.rows }} rows sent to {{ r.sentTo }}</div>
              <div v-if="r.error" class="muted">{{ r.error }}</div>
            </div>
            <span class="chip" :class="r.status">{{ STATUS_LABEL[r.status] }}</span>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>
