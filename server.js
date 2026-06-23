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

// ── CORE HTTP ────────────────────────────────────────────────────────────────
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
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("JSON parse error")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    req.write(data); req.end();
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

function serper(query) {
  return httpsPost("google.serper.dev", "/search",
    { "X-API-KEY": SERPER_API_KEY },
    { q: query, gl: "bg", hl: "bg", num: 8 }
  ).then(d => d.organic || []);
}

// ── PHASE 1: GOAL INTERPRETATION ────────────────────────────────────────────
async function interpretGoal(symptoms, city) {
  return groq([
    { role: "system", content: `You are a medical triage agent. Return ONLY valid JSON, no markdown.
{
  "understood_goal": "one sentence in Bulgarian describing what the patient needs",
  "specialist": "specialist name in Bulgarian",
  "specialist_en": "english name",
  "urgency": "спешно or скоро or планово",
  "urgency_reason": "one sentence in Bulgarian",
  "plan_steps": ["step 1 in Bulgarian", "step 2", "step 3", "step 4"],
  "thinking": ["analysis step 1 in Bulgarian", "step 2", "step 3"],
  "red_flags": ["emergency red flag 1 in Bulgarian", "red flag 2"],
  "initial_search_query": "best English search query to find clinics for this specialist in this city"
}` },
    { role: "user", content: `City: ${city}\nSymptoms: ${symptoms}` }
  ], 800);
}

// ── PHASE 2: EVALUATE & RANK ─────────────────────────────────────────────────
async function evaluateAndRank(symptoms, specialist, urgency, city, searchResults, searchQuery) {
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
  "ranking_reasoning": "paragraph in Bulgarian explaining ranking logic",
  "search_quality": "good or poor",
  "search_quality_reason": "one sentence why"
}
Max 3 recommendations. Score out of 100. Only real facilities from search results. Be strict with scores — only give 80+ if the result is clearly a real, relevant medical facility with good information.` },
    { role: "user", content: `Patient in ${city}, urgency: ${urgency}\nSymptoms: "${symptoms}"\nNeeds: ${specialist}\nSearch query used: "${searchQuery}"\nSearch results:\n${resultsText}` }
  ], 1000);
}

// ── PHASE 3: SELF-EVALUATION ─────────────────────────────────────────────────
async function selfEvaluate(symptoms, city, specialist, recommendations, avgScore) {
  const recSummary = recommendations.map((r, i) =>
    `[${i+1}] ${r.name} (score: ${r.score}, address: ${r.address ? 'yes' : 'no'}, phone: ${r.phone ? 'yes' : 'no'})`
  ).join("\n");

  return groq([
    { role: "system", content: `You are MedNav autonomous self-evaluation module. Critically assess the quality of recommendations generated. Return ONLY valid JSON, no markdown.
{
  "confidence_score": 87,
  "risk_level": "low or medium or high",
  "missing_information": ["info that would have improved recommendations, in Bulgarian"],
  "limitations": ["limitation 1 in Bulgarian", "limitation 2"],
  "why_confidence_is_not_100": "short honest explanation in Bulgarian",
  "refinement_needed": true or false,
  "refinement_reason": "why refinement is needed, in Bulgarian, or null if not needed",
  "alternative_query": "a better English search query if refinement is needed, or null"
}
Be honest and critical. If average score is below 70 or fewer than 2 strong recommendations exist, set refinement_needed to true.` },
    { role: "user", content: `Patient: "${symptoms}" in ${city}, needs ${specialist}\nAverage score: ${avgScore}\nRecommendations found:\n${recSummary}` }
  ], 600);
}

// ── PHASE 4: AUTONOMOUS REFINEMENT (if needed) ───────────────────────────────
async function refine(symptoms, specialist, urgency, city, evaluation, initialRecs, initialAvg) {
  if (!evaluation.refinement_needed) {
    return {
      performed: false,
      reason: "Initial search quality sufficient",
      initial_average_score: initialAvg,
      final_average_score: initialAvg,
      improvement: "+0",
      final_recommendations: initialRecs,
      decision_made: "Агентът прецени, че първоначалните резултати са достатъчно качествени."
    };
  }

  // Agent generates better query and searches again
  const betterQuery = evaluation.alternative_query ||
    `specialist hospital ${city} Bulgaria ${specialist} appointment`;

  const newResults = await serper(betterQuery);
  const newEval = await evaluateAndRank(symptoms, specialist, urgency, city, newResults, betterQuery);

  const newAvg = newEval.recommendations.length > 0
    ? Math.round(newEval.recommendations.reduce((s, r) => s + (r.score || 0), 0) / newEval.recommendations.length)
    : 0;

  // Agent COMPARES and picks the better set
  const useNew = newAvg > initialAvg;
  const finalRecs = useNew ? newEval.recommendations : initialRecs;
  const finalAvg = useNew ? newAvg : initialAvg;

  return {
    performed: true,
    reason: evaluation.refinement_reason || "Score below threshold",
    initial_average_score: initialAvg,
    final_average_score: finalAvg,
    improvement: `${finalAvg - initialAvg >= 0 ? '+' : ''}${finalAvg - initialAvg}`,
    refined_query: betterQuery,
    agent_chose: useNew ? "refined" : "initial",
    decision_made: useNew
      ? `Агентът реши да използва резултатите от второто търсене (avg score: ${newAvg} > ${initialAvg}).`
      : `Агентът сравни двата резултата и реши да запази първоначалните (avg score: ${initialAvg} >= ${newAvg}).`,
    final_recommendations: finalRecs,
  };
}

// ── PHASE 5: AUTONOMOUS DECISION REPORT ──────────────────────────────────────
async function generateDecisionReport(symptoms, city, goal, specialist, urgency, finalRecs, refinement, selfEval) {
  const topClinic = finalRecs[0];
  const rejected = finalRecs.slice(1).map(r => r.name).join(", ") || "none";

  return groq([
    { role: "system", content: `You are MedNav decision report generator. Create a transparent autonomous decision report. Return ONLY valid JSON, no markdown. All text in proper Bulgarian.
{
  "detected_goal": "what goal the agent understood from the patient input",
  "key_decisions": ["decision 1 the agent made autonomously", "decision 2", "decision 3"],
  "alternatives_rejected": "why the lower-ranked options were not chosen as primary",
  "final_selection_reason": "why the top clinic was selected as #1 recommendation",
  "agent_confidence_statement": "one honest sentence about confidence level"
}` },
    { role: "user", content: `Patient: "${symptoms}" in ${city}\nUnderstood goal: ${goal}\nSpecialist: ${specialist}, Urgency: ${urgency}\nTop recommendation: ${topClinic?.name || 'none'} (score: ${topClinic?.score || 0})\nAlternatives: ${rejected}\nRefinement performed: ${refinement.performed}\nFinal confidence: ${selfEval.confidence_score}%` }
  ], 500);
}

// ── PHASE 6: CARE PLAN & DOCTOR PACK ─────────────────────────────────────────
async function generateCarePlan(symptoms, specialist, urgency, city, topClinic) {
  return groq([
    { role: "system", content: `You are MedNav care planning module. Return ONLY valid JSON, no markdown. All text in proper Bulgarian.
{
  "care_plan": {
    "today": "specific action today in Bulgarian",
    "tomorrow": "action tomorrow in Bulgarian",
    "days_3_4": "days 3-4 in Bulgarian",
    "days_5_7": "days 5-7 in Bulgarian",
    "monitor": ["symptom to watch 1 in Bulgarian", "symptom 2", "symptom 3"],
    "escalate_if": ["escalate condition 1 in Bulgarian", "condition 2"]
  },
  "doctor_pack": {
    "call_script": "exact words to say when calling to book in Bulgarian",
    "questions": ["question for doctor 1 in Bulgarian", "question 2", "question 3"],
    "symptoms_summary": "2-sentence summary in Bulgarian",
    "documents_to_bring": ["document 1 in Bulgarian", "document 2", "document 3"],
    "appointment_script": "what to say at the start of the appointment in Bulgarian"
  }
}` },
    { role: "user", content: `Patient: "${symptoms}", needs ${specialist}, urgency: ${urgency}, in ${city}. Top clinic: ${topClinic || "not found"}.` }
  ], 900);
}

// ── MAIN AUTONOMOUS LOOP ─────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { symptoms, city } = req.body;
  if (!symptoms || !city) return res.status(400).json({ error: "Липсват симптоми или град." });

  try {
    // PHASE 1 — GOAL + PLAN
    const goal = await interpretGoal(symptoms, city);

    // PHASE 2 — EXECUTE: SEARCH
    const initialQuery = `${goal.specialist_en} clinic ${city} Bulgaria address phone`;
    const searchResults = await serper(initialQuery);

    // PHASE 2 — EVALUATE & RANK
    const ranking = await evaluateAndRank(symptoms, goal.specialist, goal.urgency, city, searchResults, initialQuery);
    const initialRecs = ranking.recommendations || [];
    const initialAvg = initialRecs.length > 0
      ? Math.round(initialRecs.reduce((s, r) => s + (r.score || 0), 0) / initialRecs.length)
      : 0;

    // PHASE 3 — SELF-EVALUATION
    const selfEval = await selfEvaluate(symptoms, city, goal.specialist, initialRecs, initialAvg);

    // PHASE 4 — AUTONOMOUS REFINEMENT (agent decides)
    const refinement = await refine(symptoms, goal.specialist, goal.urgency, city, selfEval, initialRecs, initialAvg);
    const finalRecs = refinement.final_recommendations || initialRecs;

    // PHASE 5 — DECISION REPORT
    const [decisionReport, carePlanData] = await Promise.all([
      generateDecisionReport(symptoms, city, goal.understood_goal, goal.specialist, goal.urgency, finalRecs, refinement, selfEval),
      generateCarePlan(symptoms, goal.specialist, goal.urgency, city, finalRecs[0]?.name || "")
    ]);

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
      // Final ranked recommendations
      recommendations: finalRecs,
      ranking_reasoning: ranking.ranking_reasoning,
      // Self-evaluation
      self_evaluation: selfEval,
      // Refinement
      refinement: {
        performed: refinement.performed,
        reason: refinement.reason,
        initial_average_score: refinement.initial_average_score,
        final_average_score: refinement.final_average_score,
        improvement: refinement.improvement,
        decision_made: refinement.decision_made,
        agent_chose: refinement.agent_chose || null,
      },
      // Decision report
      decision_report: decisionReport,
      // Care plan & doctor pack
      care_plan: carePlanData.care_plan,
      doctor_pack: carePlanData.doctor_pack,
    });

  } catch (err) {
    console.error("Agent error:", err.message);
    res.status(500).json({ error: "Агентът срещна проблем: " + err.message });
  }
});

app.get("/ping", (req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MedNav running on port ${PORT}`));
