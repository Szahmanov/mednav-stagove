const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("JSON parse error"));
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── STEP 1: Analyze symptoms ───────────────────────────────────────────────
async function analyzeSymptoms(symptoms) {
  const data = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { Authorization: `Bearer ${GROQ_API_KEY}` },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You are a medical triage agent for Bulgaria. Analyze symptoms and return ONLY valid JSON, no markdown, no extra text.
Format:
{
  "specialist": "specialist name in Bulgarian (e.g. Кардиолог, Невролог, Окулист)",
  "specialist_en": "english name (e.g. cardiologist, neurologist, ophthalmologist)",
  "urgency": "спешно or скоро or планово",
  "urgency_reason": "one short sentence in Bulgarian",
  "thinking": ["step 1 in Bulgarian", "step 2 in Bulgarian", "step 3 in Bulgarian"]
}`,
        },
        { role: "user", content: `Patient symptoms: ${symptoms}` },
      ],
    }
  );

  const text = data.choices[0].message.content;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found");
  return JSON.parse(match[0]);
}

// ─── STEP 2: Search for clinics ─────────────────────────────────────────────
async function searchClinics(specialist_en, city) {
  const query = `${specialist_en} clinic medical center ${city} Bulgaria address phone`;
  const data = await httpsPost(
    "google.serper.dev",
    "/search",
    { "X-API-KEY": SERPER_API_KEY },
    { q: query, gl: "bg", hl: "bg", num: 8 }
  );
  return data.organic || [];
}

// ─── STEP 3: Build structured recommendations ───────────────────────────────
async function buildRecommendations(symptoms, specialist, city, searchResults) {
  const resultsText = searchResults
    .map((r, i) => `[${i + 1}] TITLE: ${r.title}\nSNIPPET: ${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");

  const data = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { Authorization: `Bearer ${GROQ_API_KEY}` },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content: `You are MedNav, an autonomous medical navigation agent for Bulgaria by StaGove.
Return ONLY valid JSON, no markdown, no extra text. Use proper Bulgarian text with correct encoding - no replacement characters.
Format:
{
  "recommendations": [
    {
      "name": "Full official name of the facility",
      "type": "МБАЛ or Медицински център or ДКЦ or Поликлиника or Амбулатория",
      "address": "full street address if found in results, otherwise null",
      "maps_query": "facility name plus city for Google Maps search, e.g. Очна Болница Луксор Пловдив",
      "phone": "phone number if found in results, otherwise null",
      "url": "website URL",
      "nhif": true,
      "why": "one sentence in Bulgarian explaining why this facility suits these symptoms"
    }
  ],
  "advice": "Practical advice in Bulgarian, 2 sentences, using correct Bulgarian characters",
  "what_to_tell_doctor": "Exact script in Bulgarian of what to say when booking, using correct Bulgarian characters"
}
Include max 3 recommendations. Only real facilities from the search results. All text must be proper Bulgarian.`,
        },
        {
          role: "user",
          content: `Patient in ${city} with symptoms: "${symptoms}"\nNeeds: ${specialist}\nSearch results:\n${resultsText}`,
        },
      ],
    }
  );

  const text = data.choices[0].message.content;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found");
  return JSON.parse(match[0]);
}

// ─── MAIN ENDPOINT ──────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { symptoms, city } = req.body;
  if (!symptoms || !city) {
    return res.status(400).json({ error: "Липсват симптоми или град." });
  }

  try {
    const step1 = await analyzeSymptoms(symptoms);
    const searchResults = await searchClinics(step1.specialist_en, city);
    const step3 = await buildRecommendations(symptoms, step1.specialist, city, searchResults);

    res.json({
      thinking: step1.thinking,
      specialist: step1.specialist,
      urgency: step1.urgency,
      urgency_reason: step1.urgency_reason,
      recommendations: step3.recommendations,
      advice: step3.advice,
      what_to_tell_doctor: step3.what_to_tell_doctor,
    });
  } catch (err) {
    console.error("Agent error:", err.message);
    res.status(500).json({ error: "Агентът срещна проблем: " + err.message });
  }
});

app.get("/ping", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MedNav running on port ${PORT}`));
