/**
 * Diagnose ElevenLabs API key — prints status only, never the full key.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(serviceRoot, ".env") });

async function probe(label: string, apiKey: string, voiceId: string): Promise<void> {
  const key = apiKey.trim();
  const userRes = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": key },
  });
  const userBody = (await userRes.text()).slice(0, 100);

  const ttsUrl = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
  );
  ttsUrl.searchParams.set("output_format", "ulaw_8000");
  const ttsRes = await fetch(ttsUrl.toString(), {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/basic",
    },
    body: JSON.stringify({ text: "Test", model_id: "eleven_turbo_v2_5" }),
  });

  console.log(
    JSON.stringify({
      label,
      keyLength: key.length,
      keyPrefix: key.slice(0, 7),
      voiceId,
      userStatus: userRes.status,
      userSnippet: userBody,
      ttsStatus: ttsRes.status,
      ttsContentType: ttsRes.headers.get("content-type"),
    }),
  );
}

const voiceId = (process.env.VOICE_ID ?? "").trim();
const orderKey = process.env.ELEVENLABS_API_KEY ?? "";

await probe("order-lookup-voice-agent", orderKey, voiceId);

// Fresh env — twilio-voice-agent may hold the working production key.
const twilioOnly: Record<string, string> = {};
loadEnv({
  path: resolve(serviceRoot, "../twilio-voice-agent/.env"),
  processEnv: twilioOnly,
});
const twilioKey = twilioOnly.ELEVENLABS_API_KEY ?? "";
if (twilioKey && twilioKey.trim() !== orderKey.trim()) {
  await probe("twilio-voice-agent", twilioKey, voiceId);
}
