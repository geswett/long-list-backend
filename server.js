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
 * Sin clave de acceso: cualquiera con el link de la página puede usarla.
 *
 * Requiere Node 18 o superior (usa el fetch global de Node, sin dependencias
 * extra salvo Express para las rutas).
 */

const express = require("express");

const app = express();
app.use(express.json());

// CORS abierto.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const TEAMTAILOR_API_VERSION = "20240904";
const env = process.env; // todas las claves viven en las Environment Variables de Render

// ---------- Teamtailor ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ttFetch(path, attempt = 1) {
  const base = env.TEAMTAILOR_BASE_URL || "https://api.teamtailor.com";
  const url = path.startsWith("http") ? path : `${base}/v1${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Token token=${env.TEAMTAILOR_TOKEN}`,
      "X-Api-Version": TEAMTAILOR_API_VERSION,
      Accept: "application/vnd.api+json",
    },
  });

  // Teamtailor limita a 50 pedidos cada 10 segundos. Si nos pasamos,
  // esperamos lo que indique X-Rate-Limit-Reset (o 3s por defecto) y
  // reintentamos, hasta 5 veces, en vez de romper toda la generación.
  if (res.status === 429 && attempt <= 5) {
    const resetSeconds = Number(res.headers.get("x-rate-limit-reset")) || 3;
    console.log(`[teamtailor] 429 en ${url}, esperando ${resetSeconds}s (intento ${attempt}/5)`);
    await sleep((resetSeconds + 0.5) * 1000);
    return ttFetch(path, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.log(`[teamtailor] ERROR ${url} -> ${res.status}: ${body.slice(0, 500)}`);
    throw new Error(`Teamtailor ${url} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  console.log(
    `[teamtailor] OK ${url} -> ${res.status}, data.length=${(json.data || []).length}, meta=${JSON.stringify(json.meta || {})}`
  );
  return json;
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
  // El filtro de Teamtailor filter[status]=open no anduvo de forma confiable
  // con este token, así que traemos todos los procesos (paginando) y
  // filtramos nosotros mismos por status === "open".
  const all = await ttFetchAllPages("/jobs");
  const openOnes = all.filter((j) => j.attributes && j.attributes.status === "open");
  const jobs = openOnes.map((j) => ({
    id: j.id,
    title: j.attributes["internal-name"] || j.attributes.title,
  }));

  const debug =
    jobs.length === 0
      ? { totalJobsVistos: all.length, statusesVistos: [...new Set(all.map((j) => j.attributes && j.attributes.status))] }
      : null;

  return { jobs, debug };
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

// Teamtailor devuelve, para un mismo filtro de etapa, tanto postulaciones activas
// como rechazadas (el rechazo no las saca de la relación "stage", queda como un
// estado aparte). Hay que filtrar los rechazados a mano.
function isRejectedApplication(r) {
  const attrs = r.attributes || {};
  const status = String(attrs.status || attrs.state || "").toLowerCase();
  if (status === "rejected") return true;
  if (attrs["rejected-at"]) return true;
  if (attrs.rejected === true) return true;
  return false;
}

async function getApplicationsInStage(jobId, stageId) {
  const rows = await ttFetchAllPages(
    `/job-applications?filter[job]=${jobId}&filter[stage]=${stageId}&include=candidate`
  );

  // Diagnóstico único: si ningún campo conocido está presente, lo dejamos en el
  // log para poder ajustar isRejectedApplication con el nombre real del campo.
  const sample = rows[0];
  if (sample) {
    const attrs = sample.attributes || {};
    const knownFields = ["status", "state", "rejected-at", "rejected"];
    const hasKnownField = knownFields.some((f) => attrs[f] !== undefined);
    if (!hasKnownField) {
      console.log(
        `[job-applications] no se encontró ningún campo conocido de rechazo. attributes de ejemplo: ${JSON.stringify(attrs)}`
      );
    }
  }

  const active = rows.filter((r) => !isRejectedApplication(r));
  console.log(
    `[job-applications] etapa ${stageId}: ${rows.length} postulaciones totales, ${active.length} activas (excluidas ${rows.length - active.length} rechazadas)`
  );

  return active.map((r) => ({
    applicationId: r.id,
    candidateId: r.relationships.candidate.data.id,
  }));
}

async function getCandidateDetails(candidateId) {
  const data = await ttFetch(`/candidates/${candidateId}`);
  const attrs = data.data.attributes;
  const name = `${attrs["first-name"] || ""} ${attrs["last-name"] || ""}`.trim();

  // Teamtailor no permite filter[candidate] sobre /v1/answers ("Filter not
  // allowed"). En cambio, sí expone las respuestas de un candidato a través
  // de la ruta de relación estándar de JSON:API /v1/candidates/:id/answers.
  // Si por algún motivo esa ruta no existiera para esta cuenta, probamos
  // como respaldo el filtro viejo (algunas cuentas/tokens sí lo permiten).
  let answersRaw;
  try {
    answersRaw = await ttFetchAllPages(`/candidates/${candidateId}/answers?include=question`);
  } catch (e) {
    console.log(`[respuesta candidato ${candidateId}] ruta de relación falló (${e.message}), probando filtro clásico...`);
    answersRaw = await ttFetchAllPages(`/answers?filter[candidate]=${candidateId}&include=question`);
  }
  // Según el tipo de pregunta (texto, fecha, numérica, choice, etc.),
  // Teamtailor guarda la respuesta en un atributo distinto ("text", "date",
  // "number", "range", "choices", ...). En vez de listar a mano los que
  // conocemos (lo que nos hizo perder fecha de nacimiento y renta esperada,
  // que vienen como "date" y "number"), tomamos el primer atributo con
  // contenido real, ignorando los metadatos técnicos.
  const ANSWER_METADATA_FIELDS = new Set(["created-at", "updated-at"]);
  const answers = answersRaw.map((a) => {
    let val = null;
    for (const [key, v] of Object.entries(a.attributes || {})) {
      if (ANSWER_METADATA_FIELDS.has(key)) continue;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      val = v;
      break;
    }
    return {
      value: val,
      questionRel: a.relationships && a.relationships.question && a.relationships.question.data,
    };
  });

  // Diagnóstico único: si la primera respuesta del candidato quedó sin
  // valor, dejamos sus atributos crudos en el log para poder ajustar la
  // lista de campos si hiciera falta.
  if (answersRaw[0] && (answers[0].value === null || answers[0].value === undefined)) {
    console.log(
      `[respuestas candidato ${candidateId}] no se encontró valor utilizable. attributes de ejemplo: ${JSON.stringify(answersRaw[0].attributes)}`
    );
  }

  return {
    id: candidateId,
    name,
    resumeSummary: attrs["resume-summary"] || "",
    location: attrs["location"] || "",
    answers,
  };
}

// Las preguntas de un proceso se repiten para cada candidato -- las
// cacheamos en memoria para no volver a pedirlas y no gastar el límite de
// pedidos de Teamtailor de forma innecesaria.
const questionTitleCache = new Map();

async function resolveQuestionTitles(answers) {
  const ids = [...new Set(answers.map((a) => a.questionRel && a.questionRel.id).filter(Boolean))];
  // Uno por uno (no en paralelo) para no disparar ráfagas que gatillen el
  // rate limit de Teamtailor; los ya cacheados no generan ningún pedido.
  for (const id of ids) {
    if (questionTitleCache.has(id)) continue;
    try {
      const data = await ttFetch(`/questions/${id}`);
      questionTitleCache.set(id, data.data.attributes.title || data.data.attributes.body);
    } catch (e) {
      questionTitleCache.set(id, null);
    }
  }
  return answers.map((a) => ({
    question: a.questionRel ? questionTitleCache.get(a.questionRel.id) : null,
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

Para cada candidato en el siguiente JSON, redacta el "resumen laboral" en español. Va DENTRO DE UNA SOLA CELDA de una planilla, pero con 3 líneas separadas por saltos de línea reales (\\n dentro del string), en este orden exacto:

Línea 1: Cargo actual y empresa (del CV). Título profesional o grado más alto y universidad. Si hay 1-2 diplomados/certificaciones relevantes, agrégalos como oraciones cortas propias, todo en esta misma línea.
Línea 2: "Tiene [edad] años, vive en [ciudad]." -- calcula la edad a partir de la fecha de nacimiento en las respuestas, usando la fecha de hoy. Si la ciudad del candidato es distinta a la del cargo, o alguna respuesta indica disponibilidad para trasladarse/trabajar presencialmente en la zona del cargo, agrega "con disponibilidad a traslado" en esa misma línea.
Línea 3: "Exp. de renta preliminar $[monto con separador de miles] liq." usando la renta esperada líquida de las respuestas. Si no existe ese dato, omite esta línea completa.

No inventes datos que no estén en el CV o las respuestas: si falta un dato, arma la línea con lo que sí hay y omite lo que falta.

Ejemplo de estilo y formato exacto (solo para calibrar tono y estructura, no copiar contenido; noten los saltos de línea entre cada parte):
"Subgerente de producción, FLEX. Ingeniero Civil Industrial, Universidad Técnica Federico Santa María. Diplomado en Gestión de Recursos Humanos, Universidad Católica de Temuco. Diplomado en Gestión de operaciones y logística, Universidad de Chile.\\nTiene 40 años, vive en Santiago.\\nExp. de renta preliminar $6.000.000 liq."

Candidatos (JSON):
${JSON.stringify(payload, null, 2)}

Responde SOLO con un JSON array de strings, en el mismo orden que "index", donde cada string es el resumen de ese candidato (con los \\n reales dentro del string, como en el ejemplo). No agregues explicación ni markdown, solo el array JSON.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      // Este modelo puede usar tokens de "pensamiento" antes de escribir la
      // respuesta final; con poco margen se queda sin espacio y corta antes
      // de llegar al texto. Le damos bastante lugar de sobra.
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API -> ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  // Buscamos el primer bloque de tipo "text": si el modelo usa thinking
  // extendido, ese bloque puede no ser el [0], así que no asumimos la
  // posición.
  const textBlock = (data.content || []).find((b) => b && b.type === "text" && typeof b.text === "string");
  const text = textBlock && textBlock.text;
  if (!text) {
    console.log(`[anthropic] respuesta sin bloque de texto: ${JSON.stringify(data).slice(0, 800)}`);
    throw new Error("Anthropic no devolvió texto utilizable (revisá los logs de Render para ver la respuesta completa).");
  }
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

  // Colores y fuente sacados directamente de la planilla de ejemplo real
  // (Long List.xlsx) para que quede igual: gris de encabezados 999999,
  // texto del nombre en un teal 467886, fuente Montserrat en todo.
  const GRAY = "999999";
  const NAME_TEAL = "467886";
  const FONT = "Montserrat";
  const lastRow = values.length; // 1-indexed count == exclusive end index para rango 0-indexado

  const requests = [
    { mergeCells: { range: rng(sheetId, 1, 2, 0, 5), mergeType: "MERGE_ALL" } }, // A2:E2 título
    { mergeCells: { range: rng(sheetId, 2, 3, 1, 5), mergeType: "MERGE_ALL" } }, // B3:E3 subtítulo

    // Título (fila 2): negrita, sin relleno, centrado
    {
      repeatCell: {
        range: rng(sheetId, 1, 2, 0, 5),
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 11, fontFamily: FONT },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)",
      },
    },
    // Subtítulo + fila de encabezados (filas 3 y 4, columnas B:E): blanco negrita sobre gris
    {
      repeatCell: {
        range: rng(sheetId, 2, 4, 1, 5),
        cell: {
          userEnteredFormat: {
            backgroundColor: hex(GRAY),
            textFormat: { bold: true, fontSize: 11, fontFamily: FONT, foregroundColor: hex("FFFFFF") },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
      },
    },
    // Filas de datos (desde la 5): fuente, wrap y centrado vertical por defecto
    {
      repeatCell: {
        range: rng(sheetId, 4, lastRow, 1, 5),
        cell: {
          userEnteredFormat: {
            textFormat: { fontSize: 11, fontFamily: FONT },
            wrapStrategy: "WRAP",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(textFormat,wrapStrategy,verticalAlignment)",
      },
    },
    // Columna B (numeración): centrada horizontal también
    {
      repeatCell: {
        range: rng(sheetId, 4, lastRow, 1, 2),
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(horizontalAlignment)",
      },
    },
    // Columna C (nombre): color teal como en la plantilla
    {
      repeatCell: {
        range: rng(sheetId, 4, lastRow, 2, 3),
        cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: FONT, foregroundColor: hex(NAME_TEAL) } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Columna E (status): negrita y fondo blanco explícito, centrada
    {
      repeatCell: {
        range: rng(sheetId, 4, lastRow, 4, 5),
        cell: {
          userEnteredFormat: {
            backgroundColor: hex("FFFFFF"),
            textFormat: { bold: true, fontSize: 11, fontFamily: FONT },
            horizontalAlignment: "CENTER",
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    },
    // Bordes finos en toda la tabla (B3:E-última fila), como en la plantilla
    {
      updateBorders: {
        range: rng(sheetId, 2, lastRow, 1, 5),
        top: { style: "SOLID", width: 1, color: hex("000000") },
        bottom: { style: "SOLID", width: 1, color: hex("000000") },
        left: { style: "SOLID", width: 1, color: hex("000000") },
        right: { style: "SOLID", width: 1, color: hex("000000") },
        innerHorizontal: { style: "SOLID", width: 1, color: hex("000000") },
        innerVertical: { style: "SOLID", width: 1, color: hex("000000") },
      },
    },
    // Anchos de columna calcados de la planilla original
    { updateDimensionProperties: { range: colRng(sheetId, 0, 1), properties: { pixelSize: 44 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 1, 2), properties: { pixelSize: 40 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 2, 3), properties: { pixelSize: 191 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 3, 4), properties: { pixelSize: 577 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: colRng(sheetId, 4, 5), properties: { pixelSize: 496 }, fields: "pixelSize" } },
    // Altura fija para título/subtítulo/encabezado; las filas de datos se
    // autoajustan según el largo real del resumen de cada candidato.
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 83 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 4 }, properties: { pixelSize: 48 }, fields: "pixelSize" } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "ROWS", startIndex: 4, endIndex: lastRow } } },
  ];

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  // Compartir como "cualquiera con el link puede editar" (para que el equipo
  // pueda completar la columna de status sin tener que pedir acceso uno por
  // uno). Esto usa la API de Drive, no la de Sheets, así que el token de
  // Google necesita el scope de Drive (ver GOOGLE_REFRESH_TOKEN en el DEPLOY).
  const shareRes = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "writer", type: "anyone" }),
  });
  if (!shareRes.ok) {
    const body = await shareRes.text();
    console.log(`[drive] no se pudo compartir el sheet como público: ${shareRes.status} ${body.slice(0, 500)}`);
    // No cortamos la generación por esto: el sheet ya existe y tiene los
    // datos, solo queda restringido a la cuenta dueña hasta que se
    // resuelva el permiso (normalmente falta el scope de Drive en el token).
  }

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// ---------- Rutas ----------

app.get("/", (req, res) => res.json({ ok: true, service: "long-list-backend" }));

app.get("/api/jobs", async (req, res) => {
  try {
    const { jobs, debug } = await listOpenJobs();
    res.json({ jobs, debug });
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
