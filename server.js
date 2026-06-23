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
      hostname, path: urlPath, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
      timeout: 30000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("JSON parse error")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function groq(messages, max_tokens = 900) {
  return httpsPost("api.groq.com", "/openai/v1/chat/completions",
    { Authorization: `Bearer ${GROQ_API_KEY}` },
    { model: "llama-3.3-70b-versatile", temperature: 0.2, max_tokens, messages }
  ).then(d => {
    const text = d.choices[0].message.content;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON: " + text.slice(0, 100));
    return JSON.parse(match[0]);
  });
}

// ── STEP 1: GOAL INTERPRETATION ─────────────────────────────────────────────
async function interpretGoal(symptoms, city) {
  return groq([
    { role: "system", content: `You are a medical triage agent. Analyze and return ONLY valid JSON, no markdown.
{
  "understood_goal": "one sentence in Bulgarian describing what the patient needs",
  "specialist": "specialist name in Bulgarian",
  "specialist_en": "english name",
  "urgency": "спешно or скоро or планово",
  "urgency_reason": "one sentence in Bulgarian",
  "plan_steps": ["step 1 in Bulgarian", "step 2", "step 3", "step 4"],
  "thinking": ["analysis step 1 in Bulgarian", "step 2", "step 3"],
  "red_flags": ["symptom that would mean emergency 1 in Bulgarian", "red flag 2"]
}` },
    { role: "user", content: `City: ${city}\nSymptoms: ${symptoms}` }
  ], 700);
}

// ── STEP 2: SEARCH ───────────────────────────────────────────────────────────
async function searchClinics(specialist_en, city) {
  const data = await httpsPost("google.serper.dev", "/search",
    { "X-API-KEY": SERPER_API_KEY },
    { q: `${specialist_en} clinic medical center ${city} Bulgaria address phone НЗОК`, gl: "bg", hl: "bg", num: 8 }
  );
  return data.organic || [];
}

// ── STEP 3: EVALUATE & RANK ──────────────────────────────────────────────────
async function evaluateAndRank(symptoms, specialist, urgency, city, searchResults) {
  const resultsText = searchResults
    .map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");

  return groq([
    { role: "system", content: `You are MedNav autonomous medical agent by StaGove. Evaluate and rank clinics. Return ONLY valid JSON, no markdown. All text in proper Bulgarian.
{
  "recommendations": [
    {
      "name": "clinic name",
      "type": "МБАЛ or Медицински център or ДКЦ or Поликлиника",
      "address": "address or null",
      "maps_query": "name + city for Google Maps",
      "phone": "phone or null",
      "url": "website url",
      "nhif": true,
      "score": 85,
      "score_breakdown": {
        "specialist_match": 20,
        "urgency_fit": 18,
        "contact_info": 15,
        "location": 17,
        "accessibility": 15
      },
      "why": "one sentence in Bulgarian why this clinic fits"
    }
  ],
  "ranking_reasoning": "one paragraph in Bulgarian explaining how agent ranked the options"
}
Max 3 recommendations. Score out of 100. Only real facilities from results.` },
    { role: "user", content: `Patient in ${city}, urgency: ${urgency}\nSymptoms: "${symptoms}"\nNeeds: ${specialist}\nSearch results:\n${resultsText}` }
  ], 1000);
}

// ── STEP 4: GENERATE CARE PLAN ───────────────────────────────────────────────
async function generateCarePlan(symptoms, specialist, urgency, city, topClinic) {
  return groq([
    { role: "system", content: `You are MedNav autonomous medical agent by StaGove. Create a 7-day care plan and doctor preparation pack. Return ONLY valid JSON, no markdown. All text in proper Bulgarian.
{
  "care_plan": {
    "today": "what to do today - specific action in Bulgarian",
    "tomorrow": "what to do tomorrow in Bulgarian",
    "days_3_4": "days 3-4 action in Bulgarian",
    "days_5_7": "days 5-7 action in Bulgarian",
    "monitor": ["symptom to watch 1 in Bulgarian", "symptom 2", "symptom 3"],
    "escalate_if": ["escalate to emergency if this happens in Bulgarian", "condition 2"]
  },
  "doctor_pack": {
    "call_script": "exact words to say when calling to book in Bulgarian",
    "questions": ["question to ask doctor 1 in Bulgarian", "question 2", "question 3"],
    "symptoms_summary": "2-sentence summary of symptoms for the doctor in Bulgarian",
    "documents_to_bring": ["document 1 in Bulgarian", "document 2", "document 3"],
    "appointment_script": "what to say at the start of the appointment in Bulgarian"
  }
}` },
    { role: "user", content: `Patient: symptoms "${symptoms}", needs ${specialist}, urgency: ${urgency}, in ${city}. Top clinic: ${topClinic || "not specified"}.` }
  ], 900);
}

// ── MAIN AUTONOMOUS LOOP ─────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { symptoms, city } = req.body;
  if (!symptoms || !city) return res.status(400).json({ error: "Липсват симптоми или град." });

  try {
    // GOAL → PLAN
    const goal = await interpretGoal(symptoms, city);

    // EXECUTE → SEARCH
    const searchResults = await searchClinics(goal.specialist_en, city);

    // EVALUATE → RANK
    const evaluation = await evaluateAndRank(symptoms, goal.specialist, goal.urgency, city, searchResults);

    // IMPROVE → CARE PLAN
    const topClinicName = evaluation.recommendations?.[0]?.name || "";
    const carePlan = await generateCarePlan(symptoms, goal.specialist, goal.urgency, city, topClinicName);

    res.json({
      // Goal layer
      understood_goal: goal.understood_goal,
      plan_steps: goal.plan_steps,
      thinking: goal.thinking,
      red_flags: goal.red_flags,
      // Specialist & urgency
      specialist: goal.specialist,
      urgency: goal.urgency,
      urgency_reason: goal.urgency_reason,
      // Ranked recommendations
      recommendations: evaluation.recommendations,
      ranking_reasoning: evaluation.ranking_reasoning,
      // Care plan & doctor pack
      care_plan: carePlan.care_plan,
      doctor_pack: carePlan.doctor_pack,
    });
  } catch (err) {
    console.error("Agent error:", err.message);
    res.status(500).json({ error: "Агентът срещна проблем: " + err.message });
  }
});

app.get("/ping", (req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MedNav running on port ${PORT}`));
