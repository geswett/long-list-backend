/**
 * Long List - backend (versión para Render, sin terminal)
 *
 * Servidor Node/Express que guarda TODAS las claves sensibles (Teamtailor,
 * Google, Anthropic) como variables de entorno de Render -- nunca viajan al
 * navegador ni quedan en el repo de GitHub. La página estática
 * (frontend/index.html, en GitHub Pages) solo le habla a este servidor por
 * HTTP.
 *
 * Endpoints:
 *   GET  /api/jobs                  -> lista de procesos abiertos en Teamtailor
 *   GET  /api/jobs/:id/stages       -> etapas del pipeline de ese proceso
 *   POST /api/generate              -> arma el Long List y lo sube a Google Sheets
 *
 * Todas las rutas requieren el header `x-access-key` con el valor de la
 * variable de entorno ACCESS_PASSWORD (una clave compartida simple, no es
 * un login individual, pero evita que cualquiera con el link use la
 * herramienta).
 *
 * Requiere Node 18 o superior (usa el fetch global de Node, sin dependencias
 * extra salvo Express para las rutas).
 */

const express = require("express");

const app = express();
app.use(express.json());

// CORS abierto (protegido igual por la clave de acceso).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-access-key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const TEAMTAILOR_API_VERSION = "20240904";
const env = process.env; // todas las claves viven en las Environment Variables de Render

function checkAccess(req) {
  if (!env.ACCESS_PASSWORD) return true; // si no se configuró, no bloquea (no recomendado)
  return (req.header("x-access-key") || "") === env.ACCESS_PASSWORD;
}

app.use((req, res, next) => {
  if (!checkAccess(req)) return res.status(401).json({ error: "Clave de acceso inválida." });
  next();
});

// ---------- Teamtailor ----------

async function ttFetch(path) {
  const base = env.TEAMTAILOR_BASE_URL || "https://api.teamtailor.com";
  const url = path.startsWith("http") ? path : `${base}/v1${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Token token=${env.TEAMTAILOR_TOKEN}`,
      "X-Api-Version": TEAMTAILOR_API_VERSION,
      Accept: "application/vnd.api+json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teamtailor ${url} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

/** Trae TODAS las páginas de un listado de Teamtailor (usa meta.page-count). */
async function ttFetchAllPages(path) {
  let page = 1;
  let all = [];
  const sep = path.includes("?") ? "&" : "?";
  while (true) {
    const pageUrl = `${path}${sep}page[size]=30&page[number]=${page}`;
    const data = await ttFetch(pageUrl);
    all = all.concat(data.data || []);
    const pageCount = data.meta && data.meta["page-count"];
    if (!pageCount || page >= pageCount) break;
    page += 1;
  }
  return all;
}

async function listOpenJobs() {
  const data = await ttFetch("/jobs?filter[status]=open&page[size]=30");
  return (data.data || []).map((j) => ({
    id: j.id,
    title: j.attributes["internal-name"] || j.attributes.title,
  }));
}

async function getJob(jobId) {
  const data = await ttFetch(`/jobs/${jobId}`);
  const attrs = data.data.attributes;
  return {
    id: data.data.id,
    title: attrs["internal-name"] || attrs.title, // ya viene como "Proceso - Cliente"
  };
}

async function getStages(jobId) {
  const data = await ttFetch(`/stages?filter[job]=${jobId}&page[size]=30`);
  return (data.data || []).map((s) => ({
    id: s.id,
    name: s.attributes.name,
    activeCount: s.attributes["active-job-applications-count"],
  }));
}

async function getApplicationsInStage(jobId, stageId) {
  const rows = await ttFetchAllPages(
    `/job-applications?filter[job]=${jobId}&filter[stage]=${stageId}&include=candidate`
  );
  return rows.map((r) => ({
    applicationId: r.id,
    candidateId: r.relationships.candidate.data.id,
  }));
}

async function getCandidateDetails(candidateId) {
  const data = await ttFetch(`/candidates/${candidateId}`);
  const attrs = data.data.attributes;
  const name = `${attrs["first-name"] || ""} ${attrs["last-name"] || ""}`.trim();

  const answersRaw = await ttFetchAllPages(`/answers?filter[candidate]=${candidateId}&include=question`);
  const answers = answersRaw.map((a) => {
    const val =
      a.attributes.text ??
      (a.attributes.boolean === null ? null : a.attributes.boolean) ??
      a.attributes.range ??
      (a.attributes.choices && a.attributes.choices.length ? a.attributes.choices : null);
    return {
      value: val,
      questionRel: a.relationships && a.relationships.question && a.relationships.question.data,
    };
  });

  return {
    id: candidateId,
    name,
    resumeSummary: attrs["resume-summary"] || "",
    location: attrs["location"] || "",
    answers,
  };
}

async function resolveQuestionTitles(answers) {
  const ids = [...new Set(answers.map((a) => a.questionRel && a.questionRel.id).filter(Boolean))];
  const titles = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const data = await ttFetch(`/questions/${id}`);
        titles[id] = data.data.attributes.title || data.data.attributes.body;
      } catch (e) {
        titles[id] = null;
      }
    })
  );
  return answers.map((a) => ({
    question: a.questionRel ? titles[a.questionRel.id] : null,
    value: a.value,
  }));
}

// ---------- Anthropic (redacción del resumen) ----------

async function draftResumenes(candidates, jobLocationHint) {
  const today = new Date().toISOString().slice(0, 10);

  const payload = candidates.map((c, i) => ({
    index: i,
    nombre: c.name,
    cv: c.resumeSummary,
    respuestas: c.answersResolved,
  }));

  const prompt = `Hoy es ${today}. El cargo al que postulan estos candidatos está ubicado en/alrededor de: "${jobLocationHint || "no especificado"}".

Para cada candidato en el siguiente JSON, redacta el "resumen laboral" en español siguiendo EXACTAMENTE este estilo (oraciones cortas separadas por punto, en este orden):
1. Cargo actual y empresa (del CV).
2. Título profesional o grado más alto y universidad; si hay 1-2 diplomados/certificaciones relevantes, agrégalos como oraciones cortas propias.
3. "Tiene [edad] años, vive en [ciudad]." -- calcula la edad a partir de la fecha de nacimiento en las respuestas, usando la fecha de hoy. Si la ciudad del candidato es distinta a la del cargo, o alguna respuesta indica disponibilidad para trasladarse/trabajar presencialmente en la zona del cargo, agrega "con disponibilidad a traslado" en esa misma oración.
4. "Exp. de renta preliminar $[monto con separador de miles] liq." usando la renta esperada líquida de las respuestas. Si no existe ese dato, omite esta oración.

No inventes datos que no estén en el CV o las respuestas: si falta un dato, arma la oración con lo que sí hay y omite lo que falta.

Ejemplos de estilo (solo para calibrar tono, no copiar contenido):
"Subgerente de producción, FLEX. Ingeniero Civil Industrial, Universidad Técnica Federico Santa María. Diplomado en Gestión de Recursos Humanos, Universidad Católica de Temuco. Tiene 40 años, vive en Santiago. Exp. de renta preliminar $6.000.000 liq."
"Ex-Gerente de Operaciones Yadrán. Ingeniero Civil Industrial, Universidad de Concepción. MBA, Universidad de Concepción/Wright State University, Ohio. Tiene 49 años, vive en Puerto Varas con disponibilidad a traslado. Exp. de renta preliminar $7.000.000 liq."

Candidatos (JSON):
${JSON.stringify(payload, null, 2)}

Responde SOLO con un JSON array de strings, en el mismo orden que "index", donde cada string es el resumen de ese candidato. No agregues explicación ni markdown, solo el array JSON.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API -> ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.content && data.content[0] && data.content[0].text;
  const match = text.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : text);
}

// ---------- Google Sheets ----------

async function getGoogleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google OAuth -> ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.access_token;
}

function rng(sheetId, startRow, endRow, startCol, endCol) {
  return { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol };
}
function colRng(sheetId, startCol, endCol) {
  return { sheetId, dimension: "COLUMNS", startIndex: startCol, endIndex: endCol };
}
function hex(h) {
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

async function createLongListSheet(title, candidates) {
  const accessToken = await getGoogleAccessToken();

  const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: "Long List" } }] }),
  });
  if (!createRes.ok) throw new Error(`Sheets create -> ${createRes.status}: ${await createRes.text()}`);
  const sheet = await createRes.json();
  const spreadsheetId = sheet.spreadsheetId;
  const sheetId = sheet.sheets[0].properties.sheetId;

  const values = [
    ["", "", "", "", ""],
    [title, "", "", "", ""],
    ["", "CANDIDATOS PRESELECCIONADOS CLIENTE", "", "", ""],
    ["", "", "NOMBRE", "RESUMEN", "STATUS CANDIDATO"],
    ...candidates.map((c, i) => ["", i + 1, c.name, c.resumen, ""]),
  ];

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:E${values.length}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );

  const requests = [
    { mergeCells: { range: rng(sheetId, 1, 2, 0, 5), mergeType: "MERGE_ALL" } },
    { mergeCells: { range: rng(sheetId, 2, 3, 1, 5), mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: rng(sheetId, 1, 2, 0, 5),
        cell: { userEnteredFormat: { backgroundColor: hex("1F2937"), textFormat: { bold: true, fontSize: 14, foregroundColor: hex("FFFFFF") } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    {
      repeatCell: {
        range: rng(sheetId, 2, 4, 1, 5),
        cell: { userEnteredFormat: { backgroundColor: hex("374151"), textFormat: { bold: true, foregroundColor: hex("FFFFFF") }, horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    },
    {
      repeatCell: {
        range: rng(sheetId, 4, values.length, 0, 5),
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
      },
    },
    { updateDimensionProperties: { range: colRng(sheetId, 0, 1), properties: { pixelSize: 30 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 1, 2), properties: { pixelSize: 40 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 2, 3), properties: { pixelSize: 200 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 3, 4), properties: { pixelSize: 550 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 4, 5), properties: { pixelSize: 180 }, fields: "pixelSize" } },
  ];

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// ---------- Rutas ----------

app.get("/", (req, res) => res.json({ ok: true, service: "long-list-backend" }));

app.get("/api/jobs", async (req, res) => {
  try {
    res.json({ jobs: await listOpenJobs() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/jobs/:id/stages", async (req, res) => {
  try {
    const jobId = req.params.id;
    const [job, stages] = await Promise.all([getJob(jobId), getStages(jobId)]);
    res.json({ job, stages });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const { jobId, stageId, stageName } = req.body || {};
    if (!jobId || !stageId) return res.status(400).json({ error: "Falta jobId o stageId." });

    const job = await getJob(jobId);
    const apps = await getApplicationsInStage(jobId, stageId);
    if (apps.length === 0) return res.status(400).json({ error: "Esa etapa no tiene candidatos activos." });

    const candidates = [];
    for (const a of apps) {
      const cand = await getCandidateDetails(a.candidateId);
      const answersResolved = await resolveQuestionTitles(cand.answers);
      candidates.push({ ...cand, answersResolved });
    }

    const resumenes = await draftResumenes(candidates, job.title);
    const candidatesWithResumen = candidates.map((c, i) => ({ name: c.name, resumen: resumenes[i] || "" }));

    const title = `${stageName || "Etapa"} - ${job.title}`;
    const sheetUrl = await createLongListSheet(title, candidatesWithResumen);

    res.json({ sheetUrl, title, count: candidatesWithResumen.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Long List backend escuchando en el puerto ${PORT}`));
