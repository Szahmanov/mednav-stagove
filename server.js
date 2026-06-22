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

// Native HTTPS request to avoid node-fetch streaming issues
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("JSON parse error: " + raw.slice(0, 200)));
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── STEP 1: Groq analyzes symptoms ────────────────────────────────────────
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
          content: `Ти си медицински триажен агент. Анализираш симптоми и връщаш САМО валиден JSON без никакви допълнителни думи или markdown.
Формат:
{
  "specialist": "името на специалиста на български (напр. Кардиолог)",
  "specialist_en": "english name (e.g. cardiologist)",
  "urgency": "спешно или скоро или планово",
  "urgency_reason": "едно кратко изречение",
  "search_terms": ["термин1", "термин2"],
  "thinking": ["стъпка 1", "стъпка 2", "стъпка 3"]
}`,
        },
        { role: "user", content: `Симптоми: ${symptoms}` },
      ],
    }
  );

  const text = data.choices[0].message.content;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + text);
  return JSON.parse(match[0]);
}

// ─── STEP 2: Serper searches for real clinics ───────────────────────────────
async function searchClinics(specialist_en, city) {
  const query = `${specialist_en} clinic ${city} Bulgaria`;
  const data = await httpsPost(
    "google.serper.dev",
    "/search",
    { "X-API-KEY": SERPER_API_KEY },
    { q: query, gl: "bg", hl: "bg", num: 6 }
  );
  return data.organic || [];
}

// ─── STEP 3: Groq builds recommendations ───────────────────────────────────
async function buildRecommendations(symptoms, specialist, city, searchResults) {
  const resultsText = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");

  const data = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { Authorization: `Bearer ${GROQ_API_KEY}` },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: `Ти си MedNav — автономен медицински навигационен агент за България от StaGove.
Върни САМО валиден JSON без markdown и без допълнителни думи.
Формат:
{
  "recommendations": [
    {
      "name": "Официално наименование",
      "type": "МБАЛ или Медицински център или ДКЦ или Поликлиника",
      "address": "адрес или Виж уебсайта",
      "phone": null,
      "url": "линк",
      "nhif": true,
      "why": "едно изречение защо"
    }
  ],
  "advice": "Практически съвет (2 изречения)",
  "what_to_tell_doctor": "Какво да каже при записване"
}
Максимум 3 препоръки. Само реални заведения от резултатите.`,
        },
        {
          role: "user",
          content: `Пациент в ${city} с: "${symptoms}"\nТърси: ${specialist}\nРезултати:\n${resultsText}`,
        },
      ],
    }
  );

  const text = data.choices[0].message.content;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + text);
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
