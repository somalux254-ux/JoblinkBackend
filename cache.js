const path = require('path');
const { spawn } = require('child_process');
const Redis = require('ioredis');
const client = require('prom-client');
const dotenv = require('dotenv');

const backendEnvPath = path.resolve(__dirname, '.env');
const rootEnvPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: backendEnvPath });
dotenv.config({ path: rootEnvPath, override: false });

let redisClient = null;
let redisReady = false;
let redisConnectPromise = null;
let redisUnavailableMessageShown = false;
let redisInitializationAttempted = false;
let redisAutoStartAttempted = false;
const inMemory = new Map();

function getOrCreateCounter(name, help) {
  const existingMetric = client.register.getSingleMetric(name);
  if (existingMetric) {
    return existingMetric;
  }

  return new client.Counter({ name, help });
}

// Prometheus counters
const cacheHits = getOrCreateCounter('cache_hits_total', 'Cache hits');
const cacheMisses = getOrCreateCounter('cache_misses_total', 'Cache misses');

function isRedisEnabled() {
  return false;
}

function resolveRedisUrl() {
  if (!isRedisEnabled()) {
    return null;
  }

  const configuredUrl = process.env.REDIS_URL || (() => {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = process.env.REDIS_PORT || '6379';
    return `redis://${host}:${port}/0`;
  })();

  return configuredUrl.replace(/^redis:\/\/localhost(?=[:/])/i, 'redis://127.0.0.1');
}

function warnRedisUnavailable(error) {
  if (!redisUnavailableMessageShown) {
    redisUnavailableMessageShown = true;
    if (process.env.NODE_ENV !== 'test' && process.env.REDIS_VERBOSE !== 'false') {
      console.warn('[cache] Redis unavailable, falling back to in-memory cache:', error?.message || error);
    }
  }
}

async function ensureRedisClientWithRetry(redisUrl, attemptCount = 0) {
  try {
    await redisClient.connect();
    redisReady = true;
    return redisClient;
  } catch (error) {
    if (attemptCount >= 1) {
      redisReady = false;
      redisConnectPromise = null;
      warnRedisUnavailable(error);
      return null;
    }

    try {
      const started = await startLocalRedisIfNeeded(redisUrl);
      if (started) {
        return ensureRedisClientWithRetry(redisUrl, attemptCount + 1);
      }
    } catch (retryError) {
      // fall through to the warning below
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    return ensureRedisClientWithRetry(redisUrl, attemptCount + 1);
  }
}

function isLocalRedisTarget(redisUrl) {
  try {
    const parsed = new URL(redisUrl);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function startLocalRedisIfNeeded(redisUrl) {
  if (redisAutoStartAttempted || !isLocalRedisTarget(redisUrl)) {
    return false;
  }

  redisAutoStartAttempted = true;

  const parsed = new URL(redisUrl);
  const port = parsed.port || '6379';
  const command = process.platform === 'win32' ? 'redis-server.exe' : 'redis-server';

  try {
    const child = spawn(command, ['--save', '', '--appendonly', 'no', '--port', port], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return true;
  } catch (error) {
    if (process.env.NODE_ENV !== 'test' && process.env.REDIS_VERBOSE !== 'false') {
      console.warn('[cache] Failed to start local Redis:', error?.message || error);
    }
    return false;
  }
}

function createRedisClient(redisUrl) {
  const clientInstance = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    connectTimeout: 5000,
    commandTimeout: 5000,
    keepAlive: 10000,
  });

  clientInstance.on('connect', () => {
    redisReady = true;
  });

  clientInstance.on('ready', () => {
    redisReady = true;
  });

  clientInstance.on('reconnecting', () => {
    redisReady = false;
    if (process.env.REDIS_VERBOSE === 'true') {
      console.warn('[cache] Redis reconnecting...');
    }
  });

  clientInstance.on('end', () => {
    redisReady = false;
    redisConnectPromise = null;
  });

  clientInstance.on('error', (error) => {
    if (!redisReady) {
      warnRedisUnavailable(error);
    }
  });

  return clientInstance;
}

async function ensureRedisClient() {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) return null;
  if (redisReady && redisClient) return redisClient;

  if (!redisClient) {
    redisClient = createRedisClient(redisUrl);
  }

  if (!redisConnectPromise) {
    redisConnectPromise = (async () => {
      try {
        if (redisClient.status === 'ready') {
          redisReady = true;
          return redisClient;
        }

        return ensureRedisClientWithRetry(redisUrl);
      } catch (error) {
        redisReady = false;
        redisConnectPromise = null;
        warnRedisUnavailable(error);
        return null;
      }
    })();
  }

  return redisConnectPromise;
}

async function initializeRedis() {
  if (redisInitializationAttempted) {
    return redisReady ? redisClient : null;
  }

  redisInitializationAttempted = true;
  const connectedClient = await ensureRedisClient();
  if (connectedClient) {
    console.log('✅ Redis connected:', resolveRedisUrl());
    return connectedClient;
  }
  return null;
}

async function get(key) {
  try {
    const clientRedis = await ensureRedisClient();
    if (clientRedis) {
      const v = await clientRedis.get(key);
      if (v !== null && v !== undefined) {
        cacheHits.inc();
        return v ? JSON.parse(v) : null;
      }
      cacheMisses.inc();
      return null;
    }
    const v = inMemory.get(key);
    if (v === undefined) {
      cacheMisses.inc();
      return null;
    }
    cacheHits.inc();
    return v;
  } catch (e) {
    console.warn('[cache] get error', e?.message || e);
    return null;
  }
}

async function set(key, value, ttlSeconds = 60) {
  try {
    const clientRedis = await ensureRedisClient();
    if (clientRedis) {
      await clientRedis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    }
    inMemory.set(key, value);
    setTimeout(() => inMemory.delete(key), ttlSeconds * 1000);
    return true;
  } catch (e) {
    console.warn('[cache] set error', e?.message || e);
    return false;
  }
}

async function del(key) {
  try {
    const clientRedis = await ensureRedisClient();
    if (clientRedis) return clientRedis.del(key);
    return inMemory.delete(key);
  } catch (e) {
    console.warn('[cache] del error', e?.message || e);
    return false;
  }
}

module.exports = { get, set, del, initializeRedis, resolveRedisUrl, isRedisEnabled };
