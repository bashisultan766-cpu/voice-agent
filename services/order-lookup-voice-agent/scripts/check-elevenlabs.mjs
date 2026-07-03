#!/usr/bin/env node
/**
 * Check ElevenLabs API key, subscription/credits, and TTS synthesis.
 * Usage: ELEVENLABS_API_KEY=sk_... VOICE_ID=... node scripts/check-elevenlabs.mjs
 */
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const voiceId = (process.env.VOICE_ID || process.env.ELEVENLABS_VOICE_ID || "").trim();
const model = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

if (!apiKey) {
  console.error("ERROR: Set ELEVENLABS_API_KEY");
  process.exit(1);
}

async function main() {
  console.log("Checking ElevenLabs account...");
  const userRes = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": apiKey },
  });
  const userBody = await userRes.text();
  if (!userRes.ok) {
    console.error(`FAIL user/subscription: HTTP ${userRes.status}`);
    console.error(userBody.slice(0, 500));
    process.exit(1);
  }

  const user = JSON.parse(userBody);
  const sub = user.subscription ?? {};
  console.log("OK account");
  console.log(`  tier: ${sub.tier ?? "unknown"}`);
  console.log(`  character_count: ${sub.character_count ?? "?"}`);
  console.log(`  character_limit: ${sub.character_limit ?? "?"}`);
  const remaining =
    typeof sub.character_limit === "number" && typeof sub.character_count === "number"
      ? sub.character_limit - sub.character_count
      : null;
  if (remaining !== null) {
    console.log(`  characters_remaining: ${remaining}`);
    if (remaining <= 0) {
      console.error("FAIL: No ElevenLabs characters remaining — top up credits.");
      process.exit(1);
    }
  }

  if (!voiceId) {
    console.warn("WARN: VOICE_ID not set — skipping TTS test");
    return;
  }

  console.log(`\nTesting TTS (voice=${voiceId}, model=${model})...`);
  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: "Hi, this is SureShot Books. Voice test successful.",
        model_id: model,
        voice_settings: { stability: 0.42, similarity_boost: 0.78 },
      }),
    },
  );

  if (!ttsRes.ok) {
    const err = await ttsRes.text();
    console.error(`FAIL TTS: HTTP ${ttsRes.status}`);
    console.error(err.slice(0, 500));
    process.exit(1);
  }

  const buf = Buffer.from(await ttsRes.arrayBuffer());
  console.log(`OK TTS — received ${buf.length} bytes of audio`);
  console.log("\nElevenLabs is working. If calls are still silent, check VPS .env and pm2 logs.");
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
