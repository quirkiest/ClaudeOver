#!/usr/bin/env node
/**
 * jibo_listen_test.js - isolate the ASR path from the wakeword watcher.
 *
 * v0.1.0
 *
 * No wakeword. Connects, tells you to speak, opens a single local-ASR listen
 * and prints whatever comes back. If this works, the problem in jibo_claude.js
 * is contention between watchWakeword() and listenLocalASR() over the ASR
 * service on port 8088. If this also returns nothing, the local ASR path is
 * not producing transcripts at all and the wakeword is a red herring.
 *
 * Usage:
 *   node jibo_listen_test.js            # local ASR (default)
 *   ASR_MODE=cloud node jibo_listen_test.js   # cloud path, expected to fail
 */

const { Client } = require('rom-control');

const VERSION = '0.1.0';
const JIBO_HOST = process.env.JIBO_HOST || '192.168.20.40';
const MODE = process.env.ASR_MODE || 'local';
const WINDOW_MS = Number(process.env.JIBO_LISTEN_MS || 20000);

const jibo = new Client({ host: JIBO_HOST });

jibo.once('ready', async () => {
  console.log(`jibo_listen_test v${VERSION} - ${JIBO_HOST}, mode=${MODE}`);

  // Deliberately NOT calling watchWakeword() - that is the variable under test.
  await jibo.behavior.say('Speak now, I am listening.');

  console.log(`\n>>> SPEAK NOW - listening for ${WINDOW_MS}ms <<<\n`);
  const started = Date.now();

  try {
    const result = await jibo.audio.awaitSpeech({
      mode: MODE,
      time: WINDOW_MS,
      noSpeechTime: WINDOW_MS,
    });
    console.log(`got a result after ${Date.now() - started}ms:`);
    console.log(JSON.stringify(result, null, 2));

    const speech = result && result.speech;
    if (speech) {
      await jibo.behavior.say(`I heard you say. ${speech}`);
      console.log(`\nSUCCESS - transcript: "${speech}"`);
    } else {
      console.log('\nresult returned but no .speech field - shape above');
    }
  } catch (err) {
    console.error(`\nFAILED after ${Date.now() - started}ms: ${err.code || ''} ${err.message}`);
    console.error('if this was a timeout, local ASR is not returning transcripts.');
  } finally {
    jibo.disconnect();
    process.exit(0);
  }
});

jibo.on('error', (err) => console.error('client error:', err.message));

jibo.connect();
