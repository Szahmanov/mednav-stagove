const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// ─── STEP 1: Groq analyzes symptoms → returns specialist type ───────────────
async function analyzeSymptoms(symptoms) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `Ти си медицински триажен агент. Анализираш симптоми и връщаш САМО валиден JSON без коментари.
Формат:
{
  "specialist": "името на специалиста на български (напр. Кардиолог, Невролог, Дерматолог)",
  "specialist_en": "english name (e.g. cardiologist, neurologist)",
  "urgency": "спешно|скоро|планово",
  "urgency_reason": "едно изречение защо",
  "search_terms": ["термин1 за търсене", "термин2"],
  "thinking": ["стъпка 1 на анализа", "стъпка 2", "стъпка 3"]
}
Urgency правила: "спешно" = заплаха за живота (обади се на 112). "скоро" = в рамките на 2-3 дни. "планово" = може да се изчака.`,
        },
        {
          role: "user",
          content: `Симптоми: ${symptoms}`,
        },
      ],
    }),
  });
  const data = await response.json();
  const text = data.choices[0].message.content;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── STEP 2: Serper searches for real clinics in the city ──────────────────
async function searchClinics(specialist_en, city) {
  const query = `${specialist_en} clinic hospital ${city} Bulgaria НЗОК`;
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, gl: "bg", hl: "bg", num: 8 }),
  });
  const data = await response.json();
  return data.organic || [];
}

// ─── STEP 3: Groq processes search results → structured recommendations ─────
async function buildRecommendations(symptoms, specialist, city, searchResults) {
  const resultsText = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `Ти си MedNav — автономен медицински навигационен агент за България от StaGove. 
Получаваш реални резултати от Google за медицински заведения и ги обработваш в структуриран формат.
Върни САМО валиден JSON без markdown.
Формат:
{
  "recommendations": [
    {
      "name": "Пълно официално наименование",
      "type": "МБАЛ|Медицински център|ДКЦ|Поликлиника|Амбулатория",
      "address": "адрес ако е наличен в резултатите, иначе 'Виж уебсайта'",
      "phone": "телефон ако е наличен, иначе null",
      "url": "линк към сайта",
      "nhif": true или false (дали приема НЗОК - ако не е ясно, пиши true),
      "why": "едно изречение защо е подходящо за тези симптоми"
    }
  ],
  "advice": "Конкретен практически съвет какво да направи пациентът сега (2-3 изречения)",
  "what_to_tell_doctor": "Какво точно да каже на лекаря при записване"
}
Включи само реални заведения от резултатите. Максимум 4 препоръки. Ако резултатите са нерелевантни, върни празен масив за recommendations.`,
        },
        {
          role: "user",
          content: `Пациент в ${city} с симптоми: "${symptoms}"
Търси: ${specialist}
Резултати от търсене:\n${resultsText}`,
        },
      ],
    }),
  });
  const data = await response.json();
  const text = data.choices[0].message.content;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── MAIN AGENT ENDPOINT ────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { symptoms, city } = req.body;

  if (!symptoms || !city) {
    return res.status(400).json({ error: "Липсват симптоми или град." });
  }

  try {
    // AUTONOMOUS LOOP: 3 steps, agent decides at each step
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
    console.error("Agent error:", err);
    res.status(500).json({ error: "Агентът срещна проблем. Опитай отново." });
  }
});

// Health check for UptimeRobot
app.get("/ping", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MedNav running on port ${PORT}`));
